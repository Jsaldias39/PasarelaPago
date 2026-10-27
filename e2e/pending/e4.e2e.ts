import { randomBytes } from 'node:crypto';
import { readStream } from '../lib/events.ts';
import { seedMerchant, type SeededMerchant } from '../lib/seed.ts';
import { AVAILABLE_BEFORE_CUT, QR_GROSS_MATCHING, QR_GROSS_STATEMENT_MISMATCH, STATEMENT_MISMATCH_MINOR } from '../lib/p2-bank.ts';
import { awaitEvents, backoffice, doubleEntryOf, lastCutoffMonday, ledgerView, operatorBearer, postCapture, quote, waitForSettlementToKnow } from '../lib/p2-settlement.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E4 (carril P2, con P4) — corte semanal → payout → conciliación con UNA diferencia → excepción.
 *
 * Servicios reales: pay-ledger (con TigerBeetle privado), pay-connectors (simulador `mock`) + pay-qr, pay-merchants (relé de la siembra) y
 * pay-settlement. NO se levantan pay-payments ni pay-edge: sus cobros hoy terminan `failed/risk_denied` (D-29/D-30, ver ARNES.md § Pendientes), así que
 * el llamador de las capturas es un [DOBLE] declarado de pay-payments (como en `flows/ledger-capture.e2e.ts`). Lo que NO se puede hacer con el reloj
 * real del ledger —liberar un cobro fresco a T+7— se cubre con el doble de pruebas del servicio (`pay-settlement/test/batch.spec.ts`) y acá se afirma lo
 * contrario: que el corte NO libera lo que todavía no venció. El dinero ya liberado entra como [DOBLE] (un asiento directo a `available`).
 *
 * Vive en e2e/pending porque la conciliación de punta a punta NO puede pasar hoy: ver docs/trabajo/ola-2/P2/FLUJOS-E4-E8.md § «Qué depende del stack»
 * (la referencia del extracto del conector es `ch_…` y la clave de cruce de settlement es el `business_ref` del ledger, `pi_…:capture`).
 * Los tramos del corte y del pago NO dependen de eso y deberían pasar hoy.
 */
/**
 * El dinero ya disponible entra desde la compensación de OTRO conector: la conciliación del conector `mock` solo lee `connector:mock:clearing`, y un asiento
 * sin línea en el extracto del simulador sería una excepción `missing_in_statement` que no pertenece a lo que E4 mide.
 */
const SEED_CLEARING = 'connector:bank_transfer:clearing';
const FROM_MARGIN_MS = 60_000;
const TO_MARGIN_MS = 5 * 60_000;

describe('E4 — corte semanal → payout → conciliación → excepción', () => {
  let stack: Stack;
  let merchant: SeededMerchant;
  let startedAt: Date;
  let cutoff: string;
  const ledger = () => ledgerView(stack);
  const pending = () => ledger().balance(`merchant:${merchant.merchantId}:pending`);
  const available = () => ledger().balance(`merchant:${merchant.merchantId}:available`);

  interface Captured {
    paymentIntentId: string;
    chargeId: string;
    gross: number;
    fee: number;
    net: number;
  }
  const captured: { matching?: Captured; mismatch?: Captured } = {};
  let batchId: string;
  let payoutId: string;
  let runId: string;
  let exceptionId: string;

  /** Cobro QR real en pay-connectors (el simulador lo aprueba por el callback firmado) y su asiento de captura en el ledger real. */
  async function charge(gross: number): Promise<Captured> {
    const paymentIntentId = `pi_e4${randomBytes(6).toString('hex')}`;
    const created = await stack.callAs('pay-payments', 'pay-connectors', 'POST', '/charges', {
      merchantId: merchant.merchantId,
      headers: { 'idempotency-key': `e4-${paymentIntentId}-0001` },
      json: { payment_intent_id: paymentIntentId, merchant_id: merchant.merchantId, amount_minor: gross, currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 600_000).toISOString() },
    });
    expect({ status: created.status }).toEqual({ status: 201 });
    const chargeId = (created.json as { id: string }).id;
    await until(
      `el cobro ${chargeId} se capturó`,
      async () => (await stack.callAs('pay-payments', 'pay-connectors', 'GET', `/charges/${chargeId}/status`, { merchantId: merchant.merchantId })).json as { status: string },
      (s) => s.status === 'succeeded',
      60_000,
      250,
    );
    const { fee, net } = await postCapture(stack, { merchantId: merchant.merchantId, paymentIntentId, grossMinor: gross, channel: 'qr', connector: 'mock' });
    return { paymentIntentId, chargeId, gross, fee, net };
  }

  beforeAll(async () => {
    stack = await startStack({ only: ['pay-ledger', 'pay-qr', 'pay-connectors', 'pay-merchants', 'pay-settlement'], tolerateFailures: false });
    startedAt = new Date();
    cutoff = lastCutoffMonday();
    merchant = await seedMerchant(stack, { label: 'COMERCIO E4 (SINTÉTICO)' });
    await waitForSettlementToKnow(stack, merchant.merchantId);
  });

  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('COBROS: dos cobros QR reales se capturan y el ledger deja neto en pending y comisión en platform:fees (Bs 100,00 ⇒ 97,00 / 3,00), débitos = créditos', async () => {
    captured.matching = await charge(QR_GROSS_MATCHING);
    captured.mismatch = await charge(QR_GROSS_STATEMENT_MISMATCH);
    // La tarifa de la siembra (2,5 % + Bs 0,50) sobre Bs 100,00: comisión 3,00, neto 97,00.
    expect(quote('qr', QR_GROSS_MATCHING)).toEqual({ fee: 300, net: 9_700 });
    for (const c of [captured.matching, captured.mismatch]) {
      expect(await doubleEntryOf(stack, `${c.paymentIntentId}:capture`, [`merchant:${merchant.merchantId}:pending`, 'platform:fees', 'connector:mock:clearing'])).toEqual({ debits: c.gross, credits: c.gross });
    }
    expect(await pending()).toBe(captured.matching.net + captured.mismatch.net);
  });

  it('CORTE: el lunes de corte NO libera lo cobrado hace segundos (T+7), paga lo que ya estaba disponible UNA vez y deja el payout pagado', async () => {
    // [DOBLE] de la liberación ya vencida: el dinero que el comercio ya tiene disponible (desde otra compensación, ver SEED_CLEARING). Con el reloj real del ledger no hay otra forma de que exista a T+7.
    const seeded = await stack.callAs('pay-payments', 'pay-ledger', 'POST', '/transactions', {
      merchantId: merchant.merchantId,
      payMode: 'test',
      headers: { 'idempotency-key': `e4-available-${merchant.merchantId}` },
      json: { business_ref: `pi_e4avail${merchant.merchantId.slice(3)}:capture`, attempt: 1, currency: 'BOB', legs: [{ debit_account: SEED_CLEARING, credit_account: `merchant:${merchant.merchantId}:available`, amount_minor: AVAILABLE_BEFORE_CUT, code: 'charge' }] },
    });
    expect(seeded.status).toBe(201);
    const pendingBefore = await pending();
    const clearingBefore = await ledger().balance('payout:clearing');

    const cut = await backoffice(stack, 'POST', '/batches', { json: { cutoff_date: cutoff }, idempotencyKey: `e4-batch-${cutoff}-0001` });
    expect({ status: cut.status, code: (cut.json as { code?: string }).code }).toEqual({ status: 201, code: undefined });
    const batch = cut.json as { id: string; status: string; cutoff_date: string; released_minor: number; payouts_count: number };
    batchId = batch.id;
    expect(batch).toMatchObject({ status: 'completed', cutoff_date: cutoff, released_minor: 0, payouts_count: 1 });

    expect(await pending()).toBe(pendingBefore); // lo fresco NO se liberó
    expect(await available()).toBe(0); // todo lo disponible salió como payout
    expect((await ledger().balance('payout:clearing')) - clearingBefore).toBe(AVAILABLE_BEFORE_CUT);

    const payouts = (await backoffice(stack, 'GET', `/payouts?merchant_id=${merchant.merchantId}`)).json as { data: { id: string; status: string; amount_minor: number; batch_id: string | null; simulated: boolean; hold_id: string | null }[] };
    expect(payouts.data).toHaveLength(1);
    expect(payouts.data[0]).toMatchObject({ status: 'paid', amount_minor: AVAILABLE_BEFORE_CUT, batch_id: batchId, simulated: false });
    payoutId = payouts.data[0]!.id;

    // El conector recibió UNA orden por esa referencia y la pagó.
    const transfer = await stack.callAs('pay-settlement', 'pay-connectors', 'GET', `/transfers/${encodeURIComponent(`${payoutId}:payout:1`)}`, {});
    expect(transfer.status).toBe(200);
    expect(transfer.json).toMatchObject({ status: 'paid', amount_minor: AVAILABLE_BEFORE_CUT });

    const created = await awaitEvents(stack, 'PAY_SETTLEMENT', 'pay-settlement.payout.created', (e) => e.data.payout_id === payoutId);
    const paid = await awaitEvents(stack, 'PAY_SETTLEMENT', 'pay-settlement.payout.paid', (e) => e.data.payout_id === payoutId);
    expect([created.length, paid.length]).toEqual([1, 1]);
    expect(created[0]!.data).toMatchObject({ mode: 'test', settlement_batch_id: batchId });
  });

  it('REINTENTO: repetir el corte (misma clave, otra clave) no paga dos veces: un payout, un asiento en payout:clearing, un solo batch', async () => {
    const clearingBefore = await ledger().balance('payout:clearing');
    const sameKey = await backoffice(stack, 'POST', '/batches', { json: { cutoff_date: cutoff }, idempotencyKey: `e4-batch-${cutoff}-0001` });
    expect(sameKey.status).toBe(201);
    expect(sameKey.headers.get('idempotency-replayed')).toBe('true');
    const otherKey = await backoffice(stack, 'POST', '/batches', { json: { cutoff_date: cutoff }, idempotencyKey: `e4-batch-${cutoff}-0002` });
    expect(otherKey.status).toBe(200); // el lote ya existía: no se crea otro
    expect((otherKey.json as { id: string }).id).toBe(batchId);

    const payouts = (await backoffice(stack, 'GET', `/payouts?merchant_id=${merchant.merchantId}`)).json as { data: unknown[] };
    expect(payouts.data).toHaveLength(1);
    expect(await ledger().balance('payout:clearing')).toBe(clearingBefore);
    const payoutLines = (await ledger().lines('payout:clearing')).filter((l) => l.business_ref === `${payoutId}:payout`);
    expect(payoutLines.map((l) => l.direction)).toEqual(['credit']);
    expect((await readStream(stack, 'PAY_SETTLEMENT', 'pay-settlement.payout.created', (e) => e.data.payout_id === payoutId))).toHaveLength(1);
    const batches = (await backoffice(stack, 'GET', '/batches')).json as { data: { id: string }[] };
    expect(batches.data.map((b) => b.id)).toEqual([batchId]);
  });

  it('PRECONDICIÓN DEL CRUCE: el extracto del conector trae `payment_intent_id` (`pi_…`) de nuestros cobros, que es la clave con que settlement cruza contra el ledger (`pi_…:capture`)', async () => {
    const window = `from=${encodeURIComponent(new Date(startedAt.getTime() - FROM_MARGIN_MS).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + TO_MARGIN_MS).toISOString())}`;
    const res = await stack.callAs('pay-settlement', 'pay-connectors', 'GET', `/statements?connector=mock&${window}&limit=100`, {});
    expect(res.status).toBe(200);
    const lines = (res.json as { data: { our_reference: string | null; payment_intent_id?: string | null; direction: string; amount_minor: number }[] }).data;
    const wanted = [captured.matching!, captured.mismatch!].map((c) => c.paymentIntentId);
    // Contrato `StatementLine.payment_intent_id` (opcional, `^pi_…`, nulo sin emparejamiento). Si P4 aún no lo emite, este test falla ACÁ (y no más abajo con una
    // excepción confusa): es la señal de que falta el campo en `fetchStatement` de pay-connectors, no de que la conciliación esté mal.
    expect(lines.map((l) => l.payment_intent_id).filter((r) => wanted.includes(r ?? ''))).toEqual(expect.arrayContaining(wanted));
  });

  it('CONCILIACIÓN: el extracto trae Bs 1,00 menos en UN cobro ⇒ una sola excepción amount_mismatch con la diferencia; lo demás cruza; el ledger NO se mueve; settlement avisa UNA vez', async () => {
    const accounts = [`merchant:${merchant.merchantId}:pending`, `merchant:${merchant.merchantId}:available`, 'platform:fees', 'connector:mock:clearing', 'payout:clearing'];
    const snapshot = async () => Promise.all(accounts.map((a) => ledger().balance(a)));
    const before = await snapshot();

    const started = await backoffice(stack, 'POST', '/reconciliation_runs', {
      json: { connector: 'mock', period_from: new Date(startedAt.getTime() - FROM_MARGIN_MS).toISOString(), period_to: new Date(Date.now() + TO_MARGIN_MS).toISOString() },
      idempotencyKey: 'e4-recon-0001',
    });
    expect(started.status).toBe(202);
    runId = (started.json as { id: string }).id;
    const run = await until(`la corrida ${runId} termina`, async () => (await backoffice(stack, 'GET', `/reconciliation_runs/${runId}`)).json as { status: string; matched_count: number; exception_count: number; failure_code: string | null }, (r) => r.status !== 'running', 60_000, 250);
    expect(run).toMatchObject({ status: 'completed', exception_count: 1, failure_code: null });
    expect(run.matched_count).toBeGreaterThanOrEqual(1);

    const open = (await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json as { data: { id: string; kind: string; business_ref: string | null; statement_amount_minor: number | null; ledger_amount_minor: number | null }[] };
    expect(open.data).toHaveLength(1);
    const mismatch = captured.mismatch!;
    expect(open.data[0]).toMatchObject({
      kind: 'amount_mismatch',
      business_ref: `${mismatch.paymentIntentId}:capture`,
      statement_amount_minor: mismatch.gross - STATEMENT_MISMATCH_MINOR,
      ledger_amount_minor: mismatch.gross,
    });
    exceptionId = open.data[0]!.id;

    expect(await snapshot()).toEqual(before); // la conciliación NUNCA ajusta el ledger sola

    const opened = await awaitEvents(stack, 'PAY_SETTLEMENT', 'pay-settlement.reconciliation.exception.opened', (e) => e.data.exception_id === exceptionId);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.data).toMatchObject({ kind: 'amount_mismatch', difference_minor: -STATEMENT_MISMATCH_MINOR, payment_intent_id: mismatch.paymentIntentId, currency: 'BOB' });
  });

  it('CONCILIACIÓN REPETIDA: otra corrida sobre el mismo periodo no reabre ni vuelve a avisar lo ya conocido', async () => {
    const again = await backoffice(stack, 'POST', '/reconciliation_runs', {
      json: { connector: 'mock', period_from: new Date(startedAt.getTime() - FROM_MARGIN_MS).toISOString(), period_to: new Date(Date.now() + TO_MARGIN_MS).toISOString() },
      idempotencyKey: 'e4-recon-0002',
    });
    expect(again.status).toBe(202);
    const id = (again.json as { id: string }).id;
    expect(id).not.toBe(runId);
    await until(`la corrida ${id} termina`, async () => (await backoffice(stack, 'GET', `/reconciliation_runs/${id}`)).json as { status: string }, (r) => r.status !== 'running', 60_000, 250);
    const open = (await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json as { data: { id: string }[] };
    expect(open.data.map((e) => e.id)).toEqual([exceptionId]);
    expect(await readStream(stack, 'PAY_SETTLEMENT', 'pay-settlement.reconciliation.exception.opened', (e) => e.data.exception_id === exceptionId)).toHaveLength(1);
  });

  it('RESOLUCIÓN: la decide una persona. Sin credencial 401; un operador no pide ajustes (403); un administrador descarta y la excepción deja de estar abierta', async () => {
    const resolve = (operator: string | undefined, body: object, key: string) => backoffice(stack, 'POST', `/reconciliation_exceptions/${exceptionId}/resolve`, { json: body, idempotencyKey: key, ...(operator && { operator }) });
    const dismiss = { resolution: 'dismiss', note: 'Diferencia de Bs 1,00 del simulador (escenario 09): sin acción' };
    expect((await resolve(undefined, dismiss, 'e4-resolve-0001')).status).toBe(401);
    expect((await resolve(operatorBearer(stack, ['settlement_operator']), { resolution: 'request_adjustment', note: 'Pedido de ajuste' }, 'e4-resolve-0002')).status).toBe(403);
    expect((await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json).toMatchObject({ data: [{ id: exceptionId }] });

    const done = await resolve(operatorBearer(stack, ['settlement_admin'], { sub: 'op_e2e_carla' }), dismiss, 'e4-resolve-0003');
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ id: exceptionId, status: 'dismissed', resolved_by: 'op_e2e_carla' });
    expect((await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json).toMatchObject({ data: [] });
  });

  it('MODO: settlement (despliegue sandbox) solo opera con claves `test`: una `live` o sin modo recibe 403 y no se escribe nada', async () => {
    const countBefore = ((await backoffice(stack, 'GET', '/payouts')).json as { data: unknown[] }).data.length;
    expect((await backoffice(stack, 'GET', '/payouts', { payMode: 'live' })).status).toBe(403);
    expect((await backoffice(stack, 'GET', '/payouts', { payMode: null })).status).toBe(403);
    expect((await backoffice(stack, 'POST', '/batches', { json: { cutoff_date: cutoff }, idempotencyKey: 'e4-live-0001', payMode: 'live' })).status).toBe(403);
    expect(((await backoffice(stack, 'GET', '/payouts')).json as { data: unknown[] }).data).toHaveLength(countBefore);
  });
});
