import { readStream } from '../lib/events.ts';
import {
  BOB,
  fundWallet,
  laPazToday,
  ledgerReader,
  makeMandateDueToday,
  scheduledPaymentsOf,
  startExtraExecutors,
  waitForReplica,
  type ExtraExecutors,
} from '../lib/p5-schedules.ts';
import { MerchantReceiver } from '../lib/receiver.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E5 — pago mensual del médico con saldo AloVida: sin fondos → reintento → éxito (PLAN-MAESTRO §6; procesos 7.7).
 *
 * Hoy vive en e2e/pending (`yarn e2e:pending`) porque lo escribe P5 sin haber levantado el stack (lo corre P1, un stack a la vez). Pasa a
 * e2e/flows con `git mv e2e/pending/e5.e2e.ts e2e/flows/e5.e2e.ts` (mismas rutas relativas, sin otro cambio) cuando una corrida real en
 * `yarn e2e:pending` lo dé en verde. Qué asume, paso a paso y cómo se mide: docs/trabajo/ola-2/P5/FLUJO-E5.md.
 *
 * REALIDAD ACTUAL (PR-18): `pay-schedules` ejecuta DIRECTO contra `pay-ledger` (retención → confirmación → liberación). No pasa por
 * `pay-payments` ni por `pay-risk`, y no emite `payment_intent.*`. Las aserciones marcadas «PR-18» son las que cambiarían si el ejecutor
 * migra a `POST /intents` (ver el apartado «Si se migra a POST /intents» del documento).
 *
 * DOBLES declarados: (1) los dos comercios salen de la siembra de sandbox (`seedMerchant`, no hay API de operador usable); (2) el saldo del
 * médico se carga con un asiento de APERTURA SINTÉTICO en `pay-ledger` (no existe una entrada de dinero real a la billetera todavía);
 * (3) si hoy es 29, 30 o 31 el vencimiento se adelanta a hoy en la base de `pay-schedules` (`makeMandateDueToday`); (4) cuatro ejecutores
 * `pay-schedules` extra, REALES, contra la misma base y el mismo ledger. El reloj del servicio NO se toca: es el real.
 */
const MANDATE_AMOUNT = BOB(1000);
const FIRST_FUNDS = BOB(500);
const TOP_UP = MANDATE_AMOUNT - FIRST_FUNDS;
const EXECUTORS = 5;

/** El mismo entorno para el `pay-schedules` del stack y los extra: ejecutor cada 1 s y reintento a los 8 s (la política real es de horas). */
const SCHEDULES_ENV = { RETRY_DELAYS_SECONDS: '8,8,8,8', RUN_INTERVAL_SECONDS: '1', HOLD_EXPIRES_SECONDS: '3600' };

describe('E5 — pago mensual del médico con saldo AloVida: sin fondos → reintento → éxito', () => {
  let stack: Stack;
  let doctor: SeededMerchant;
  let supplier: SeededMerchant;
  let receiver: MerchantReceiver;
  let extra: ExtraExecutors;
  let mandateId: string;
  const ledger = () => ledgerReader(stack);
  const headers = (extraHeaders: Record<string, string> = {}) => ({ authorization: `Bearer ${doctor.token}`, ...extraHeaders });
  const payer = () => `merchant:${doctor.merchantId}:available`;
  const beneficiary = () => `merchant:${supplier.merchantId}:available`;
  const reserve = () => `schedule:${mandateId}:reserve`;
  const payments = () => scheduledPaymentsOf(stack, mandateId);
  const busEvents = (type: string) => readStream(stack, 'PAY_SCHEDULES', `pay-schedules.scheduled_payment.${type}`, (e) => e.data.mandate_id === mandateId);
  const delivered = (type: string) =>
    [...receiver.accepted.values()].filter((a) => a.path === '/hook-e5').map((a) => JSON.parse(a.body) as { type: string; mode: string }).filter((e) => e.type === `scheduled_payment.${type}`);
  const listMandate = async () => {
    const res = await stack.call('pay-edge', 'GET', '/v1/mandates', { headers: headers() });
    expect(res.status).toBe(200);
    return (res.json as { data: { id: string; status: string; next_run_on: string | null }[] }).data.find((m) => m.id === mandateId);
  };

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, envOverrides: { 'pay-schedules': SCHEDULES_ENV } });
    doctor = await seedMerchant(stack, { label: 'MÉDICO E5 (SINTÉTICO)' });
    supplier = await seedMerchant(stack, { label: 'PROVEEDOR E5 (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, doctor)).ok).toBe(true);
    // El mandato se valida contra la réplica de comercios de pay-schedules (eventos merchant.* por NATS): se espera a que conozca a los dos.
    expect((await waitForReplica(stack, [doctor.merchantId, supplier.merchantId])).ok).toBe(true);
    extra = await startExtraExecutors(stack, EXECUTORS - 1, SCHEDULES_ENV);
    receiver = new MerchantReceiver({ port: stack.receiver.port, certFile: stack.receiver.certFile, keyFile: stack.receiver.keyFile });
    await receiver.listen();
  });

  afterAll(async () => {
    await receiver?.close();
    const survivors = extra ? await extra.stop() : [];
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
    expect(survivors).toEqual([]);
  });

  it('SIEMBRA [DOBLE]: el médico tiene Bs 500,00 por un asiento de apertura sintético (idempotente); el proveedor, nada', async () => {
    const opening = await fundWallet(stack, doctor.merchantId, FIRST_FUNDS, `${doctor.merchantId}:1`);
    expect(opening).toMatch(/^tx_[a-z0-9]{10,40}$/);
    expect(await fundWallet(stack, doctor.merchantId, FIRST_FUNDS, `${doctor.merchantId}:1`)).toBe(opening); // repetir la apertura no suma
    expect(await ledger().balance(payer())).toBe(FIRST_FUNDS);
    expect(await ledger().balance(beneficiary())).toBe(0);

    const endpoint = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', {
      headers: headers({ 'idempotency-key': 'e5-endpoint-0001' }),
      json: { url: `https://127.0.0.1:${stack.receiver.port}/hook-e5`, enabled_events: ['scheduled_payment.insufficient_funds', 'scheduled_payment.executed', 'scheduled_payment.failed'] },
    });
    expect({ status: endpoint.status, body: endpoint.json }).toMatchObject({ status: 201 });
    receiver.route('/hook-e5', { secret: (endpoint.json as { secret: string }).secret, mode: 'up' });
  });

  it('el médico programa Bs 1.000,00 mensuales al proveedor por la API pública, con sk_test_ (el modo lo fija el borde)', async () => {
    const today = laPazToday();
    const body = {
      kind: 'pay_obligation',
      beneficiary_merchant_id: supplier.merchantId,
      amount_minor: MANDATE_AMOUNT,
      currency: 'BOB',
      schedule: { frequency: 'monthly', day_of_month: Math.min(Number(today.slice(8, 10)), 28), start_date: today },
      description: 'E5 SINTÉTICO — pago mensual',
    };
    const created = await stack.call('pay-edge', 'POST', '/v1/mandates', { headers: headers({ 'idempotency-key': 'e5-mandate-0001' }), json: body });
    expect({ status: created.status, body: created.json }).toMatchObject({ status: 201, body: { object: 'mandate', status: 'active', amount_minor: MANDATE_AMOUNT, beneficiary_merchant_id: supplier.merchantId } });
    mandateId = (created.json as { id: string }).id;
    expect(mandateId).toMatch(/^md_[a-z0-9]{10,40}$/);

    const replay = await stack.call('pay-edge', 'POST', '/v1/mandates', { headers: headers({ 'idempotency-key': 'e5-mandate-0001' }), json: body });
    expect((replay.json as { id: string }).id).toBe(mandateId); // el mismo POST no crea un segundo mandato
    expect((await stack.call('pay-edge', 'GET', '/v1/mandates', { headers: headers() })).json).toMatchObject({ data: [{ id: mandateId }] });

    // Antes de que venza, el ejecutor no hace nada. Se adelanta SOLO si el día 29–31 impide que hoy sea el día del mes (doble del reloj).
    await makeMandateDueToday(stack, mandateId);
  });

  it('PRIMER INTENTO: con Bs 500,00 de Bs 1.000,00 espera fondos, avisa UNA vez y no mueve dinero (aunque haya 5 ejecutores)', async () => {
    const waiting = await until('el pago programado queda esperando fondos', payments, (rows) => rows.some((r) => r.status === 'waiting_funds'), 60_000, 250);
    expect(waiting).toHaveLength(1); // una fila por (mandato, periodo)
    const [first] = waiting;
    expect(first).toMatchObject({ period: laPazToday().slice(0, 7), status: 'waiting_funds', attempts: 1, last_failure_code: 'insufficient_funds', ledger_transaction_id: null, needs_review: false });

    // PR-18: el aviso es `scheduled_payment.insufficient_funds` de pay-schedules; con POST /intents sería un `payment_intent.failed` de pay-payments.
    const notices = await until('el aviso de fondos insuficientes llega al bus', () => busEvents('insufficient_funds'), (events) => events.some((e) => e.data.attempt === 1), 30_000, 250);
    const attemptOne = notices.filter((e) => e.data.attempt === 1);
    expect(attemptOne).toHaveLength(1); // un solo aviso por intento: los 5 ejecutores no lo repiten
    expect(attemptOne[0]!.data).toMatchObject({ mandate_id: mandateId, merchant_id: doctor.merchantId, mode: 'test', currency: 'BOB', required_minor: MANDATE_AMOUNT, available_minor: FIRST_FUNDS, scheduled_payment_id: first!.id });
    expect(typeof attemptOne[0]!.data.retry_at).toBe('string');

    // El médico se entera por su webhook (y el evento es de modo test).
    const webhooks = await until('el webhook de fondos insuficientes llega al médico', async () => delivered('insufficient_funds'), (events) => events.length >= 1, 60_000, 250);
    expect(webhooks[0]!.mode).toBe('test');

    expect((await listMandate())?.status).toBe('paused_insufficient_funds');
    // Sin movimiento: el rechazo no retiene nada. Ni el médico perdió saldo, ni hay reserva, ni cobró el proveedor.
    expect(await ledger().balance(payer())).toBe(FIRST_FUNDS);
    expect(await ledger().balance(reserve())).toBe(0);
    expect(await ledger().balance(beneficiary())).toBe(0);
    expect((await ledger().statement(payer())).filter((l) => l.direction === 'debit')).toEqual([]);
  });

  it('REINTENTO: al llegar los otros Bs 500,00 el pago se ejecuta UNA vez, con asiento tx_ del ledger, y el proveedor cobra Bs 1.000,00', async () => {
    await fundWallet(stack, doctor.merchantId, TOP_UP, `${doctor.merchantId}:2`);
    expect(await ledger().balance(payer())).toBe(MANDATE_AMOUNT);

    const rows = await until('el pago programado se ejecuta', payments, (list) => list.some((r) => r.status === 'executed'), 90_000, 250);
    expect(rows).toHaveLength(1);
    const [done] = rows;
    expect(done).toMatchObject({ status: 'executed', phase: 'done', attempts: 2, needs_review: false, last_failure_code: null });
    expect(done!.ledger_transaction_id).toMatch(/^tx_[a-z0-9]{10,40}$/);

    // El asiento citado por pay-schedules es el de la liberación al proveedor y está confirmado en el ledger REAL.
    const tx = await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/transactions/${encodeURIComponent(`${done!.id}:release`)}`, { payMode: 'test' });
    expect({ status: tx.status, id: (tx.json as { id: string }).id, state: (tx.json as { status: string }).status }).toEqual({ status: 200, id: done!.ledger_transaction_id, state: 'posted' });

    // Saldos finales: el médico 0; la reserva vacía; el proveedor Bs 1.000,00. Débitos = créditos del pago.
    expect(await ledger().balance(payer())).toBe(0);
    expect(await ledger().balance(reserve())).toBe(0);
    expect(await ledger().balance(beneficiary())).toBe(MANDATE_AMOUNT);

    // SIN DOBLE DÉBITO: del médico salió Bs 1.000,00 en UNA retención; el rechazo del primer intento no dejó nada.
    const payerLines = await ledger().statement(payer());
    const debits = payerLines.filter((l) => l.direction === 'debit');
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ business_ref: `${done!.id}:reserve`, amount_minor: MANDATE_AMOUNT, counterparty_account: reserve() });
    expect(payerLines.filter((l) => l.direction === 'credit').reduce((total, l) => total + l.amount_minor, 0)).toBe(MANDATE_AMOUNT); // las dos aperturas
    const credits = (await ledger().statement(beneficiary())).filter((l) => l.direction === 'credit');
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ business_ref: `${done!.id}:release`, amount_minor: MANDATE_AMOUNT, code: 'mandate' });

    // El mandato sigue vigente para el mes que viene.
    const mandate = await listMandate();
    expect(mandate?.status).toBe('active');
    expect(mandate?.next_run_on).toBeTruthy();
    expect((mandate!.next_run_on as string) > laPazToday()).toBe(true);
  });

  it('REINTENTO SEGURO: repetir la retención y la liberación con la MISMA clave devuelve lo mismo y no mueve dinero otra vez', async () => {
    const [done] = await payments();
    // Lo que pay-schedules mandó, byte a byte: la retención del intento 2 (el 1 fue rechazado) y la liberación.
    const hold = await stack.callAs('pay-schedules', 'pay-ledger', 'POST', '/holds', {
      payMode: 'test',
      headers: { 'idempotency-key': `${done!.id}:reserve:${done!.ledger_attempt}` },
      json: { business_ref: `${done!.id}:reserve`, attempt: done!.ledger_attempt, debit_account: payer(), credit_account: reserve(), amount_minor: MANDATE_AMOUNT, currency: 'BOB', expires_in_seconds: 3600 },
    });
    expect({ status: hold.status, id: (hold.json as { id: string }).id, result: (hold.json as { result: string }).result, state: (hold.json as { status: string }).status }).toEqual({ status: 200, id: done!.hold_id, result: 'exists', state: 'posted' });

    const release = await stack.callAs('pay-schedules', 'pay-ledger', 'POST', '/transactions', {
      payMode: 'test',
      headers: { 'idempotency-key': `${done!.id}:release` },
      json: { business_ref: `${done!.id}:release`, attempt: 1, currency: 'BOB', legs: [{ debit_account: reserve(), credit_account: beneficiary(), amount_minor: MANDATE_AMOUNT, code: 'mandate' }] },
    });
    expect({ status: release.status, id: (release.json as { id: string }).id, result: (release.json as { result: string }).result }).toEqual({ status: 200, id: done!.ledger_transaction_id, result: 'exists' });

    expect(await ledger().balance(payer())).toBe(0);
    expect(await ledger().balance(beneficiary())).toBe(MANDATE_AMOUNT);
    expect((await ledger().statement(payer())).filter((l) => l.direction === 'debit')).toHaveLength(1);
  });

  it('UN SOLO EFECTO con 5 ejecutores en carrera: un solo `executed` en el bus y en el webhook, una sola fila, ningún pago más', async () => {
    expect(extra.pids).toHaveLength(EXECUTORS - 1);
    // Leído al FINAL, cuando ya pasaron varias vueltas de los cinco ejecutores (cada 1 s) desde que se ejecutó: una segunda ejecución ya se vería.
    const executed = await until('el evento executed llega al bus', () => busEvents('executed'), (events) => events.length >= 1, 30_000, 250);
    expect(executed).toHaveLength(1);
    const [done] = await payments();
    expect(executed[0]!.data).toMatchObject({ scheduled_payment_id: done!.id, mandate_id: mandateId, merchant_id: doctor.merchantId, mode: 'test', amount_minor: MANDATE_AMOUNT, currency: 'BOB', ledger_transfer_id: done!.ledger_transaction_id });

    const webhooks = await until('el webhook executed llega al médico', async () => delivered('executed'), (events) => events.length >= 1, 60_000, 250);
    expect(webhooks).toHaveLength(1);
    expect(delivered('failed')).toEqual([]);
    expect(await payments()).toHaveLength(1);
    expect((await busEvents('failed'))).toEqual([]);
    expect((await busEvents('insufficient_funds')).filter((e) => e.data.attempt === 2)).toEqual([]); // el reintento no volvió a esperar fondos
  });
});
