import { ledgerOfCapture, publicApi } from '../lib/flow.ts';
import { connectorEvents } from '../lib/events.ts';
import { BANK_TRANSFER_GROSS, BANK_TRANSFER_WRONG_AMOUNT, payerTransfersToBank } from '../lib/p2-bank.ts';
import { awaitEvents, backoffice, doubleEntryOf, ledgerView, quote } from '../lib/p2-settlement.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E8 (carril P4 · P2 · P3) — transferencia bancaria confirmada por la línea del extracto (D-03).
 *
 * El pagador transfiere al banco con la referencia única de la instrucción; el banco NO avisa: el cobro pasa a `succeeded` cuando el conector encuentra en
 * el extracto un crédito con esa referencia y el importe exacto. Después, la conciliación de settlement cruza esa misma línea contra el asiento del ledger.
 *
 * Vive en e2e/pending por TRES cosas que hoy no existen (docs/trabajo/ola-2/P2/FLUJOS-E4-E8.md § «Qué depende del stack»):
 *  1. el depósito del pagador en el banco simulado: lo trae `pay-mockbank` (P4.H4.M3, en construcción); `payerTransfersToBank` falla diciendo por qué;
 *  2. los cobros de `pay-payments` terminan `failed/risk_denied` en el arnés (D-29/D-30, ver ARNES.md § Pendientes);
 *  3. que `fetchStatement` de pay-connectors (P4) emita `payment_intent_id` en la línea: settlement cruza por ese campo (`pi_…` ⇒ `pi_…:capture`) y usa `our_reference` solo de respaldo.
 * Importes: constantes nombradas en `e2e/lib/p2-bank.ts` (los de pay-mockbank, cuando existan, se cambian ahí).
 */
const CONNECTOR = 'bank_transfer';

describe('E8 — transferencia bancaria confirmada por la línea del extracto', () => {
  let stack: Stack;
  let merchant: SeededMerchant;
  let api: ReturnType<typeof publicApi>;
  let startedAt: Date;
  const authorization = () => ({ authorization: `Bearer ${merchant.token}` });
  const ok = quote('bank_transfer', BANK_TRANSFER_GROSS);

  interface Instructions {
    id: string;
    reference: string;
  }
  let main: Instructions;
  let wrong: Instructions;

  /** Cobro por transferencia bancaria por la API pública del borde (`payment_method.type = bank_transfer`). */
  async function createBankTransferIntent(amount: number, key: string) {
    const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { ...authorization(), 'idempotency-key': key }, json: { amount_minor: amount, currency: 'BOB', payment_method: { type: 'bank_transfer' } } });
    return { status: res.status, intent: res.json as { id: string; status: string; fee_minor: number; net_minor: number; next_action?: { type: string; bank_transfer?: { reference: string; bank_name: string; account_holder: string; account_number: string } } } };
  }

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, mockbank: true });
    startedAt = new Date();
    merchant = await seedMerchant(stack, { label: 'COMERCIO E8 (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    api = publicApi(stack, merchant);
  });

  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('INSTRUCCIONES: el cobro nace requires_action con la referencia única y la cuenta recaudadora SINTÉTICA de sandbox; repetir la petición devuelve el mismo cobro y la misma referencia', async () => {
    const created = await createBankTransferIntent(BANK_TRANSFER_GROSS, 'e8-intent-main-0001');
    expect(created.status).toBe(201);
    expect(created.intent).toMatchObject({ status: 'requires_action', fee_minor: ok.fee, net_minor: ok.net });
    expect(created.intent.next_action?.type).toBe('bank_transfer_instructions');
    const instructions = created.intent.next_action!.bank_transfer!;
    expect(instructions.reference).toMatch(/\S/);
    // La cuenta es la sintética declarada de sandbox (README de pay-connectors): nunca parece una cuenta real.
    expect(instructions).toMatchObject({ bank_name: 'BANCO SIMULADO (SANDBOX)', account_holder: 'ALOVIDA PAY (SANDBOX)', account_number: 'SANDBOX-0000-0001' });
    main = { id: created.intent.id, reference: instructions.reference };

    const replay = await createBankTransferIntent(BANK_TRANSFER_GROSS, 'e8-intent-main-0001');
    expect(replay.intent.id).toBe(main.id);
    expect(replay.intent.next_action?.bank_transfer?.reference).toBe(main.reference);
  });

  it('ANTES DEL EXTRACTO: sin la línea del banco el cobro sigue abierto y el ledger no tiene nada (el banco no avisa, no hay callback)', async () => {
    expect((await api.getIntent(main.id)).status).toBe('requires_action');
    expect(await ledgerOfCapture(stack, merchant.merchantId, main.id)).toMatchObject({ pending: 0, captureLinesOnPending: 0 });
  });

  it('CONFIRMACIÓN POR EL EXTRACTO: el crédito con la referencia y el importe exactos captura el cobro; el ledger deja neto en pending y comisión en fees, débitos = créditos', async () => {
    await payerTransfersToBank(stack, { reference: main.reference, amountMinor: BANK_TRANSFER_GROSS });
    const settled = await api.settle(main.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });

    const view = ledgerView(stack);
    expect(await view.balance(`merchant:${merchant.merchantId}:pending`)).toBe(ok.net);
    expect(await doubleEntryOf(stack, `${main.id}:capture`, [`merchant:${merchant.merchantId}:pending`, 'platform:fees', `connector:${CONNECTOR}:clearing`])).toEqual({ debits: BANK_TRANSFER_GROSS, credits: BANK_TRANSFER_GROSS });
    expect((await view.lines(`merchant:${merchant.merchantId}:pending`)).filter((l) => l.business_ref === `${main.id}:capture`)).toHaveLength(1);
    expect((await api.balance()).body.pending_minor).toBe(ok.net);
  });

  it('UNA SOLA VEZ: el conector vuelve a leer la misma línea en cada ciclo y NO captura dos veces: un evento captured, una captura en el ledger', async () => {
    const events = await until('el conector publicó la captura', () => connectorEvents(stack, main.id), (e) => e.length >= 1);
    // Una conciliación de settlement (otro ciclo de lectura del extracto) no cambia el efecto.
    const run = await backoffice(stack, 'POST', '/reconciliation_runs', { json: { connector: CONNECTOR, period_from: new Date(startedAt.getTime() - 60_000).toISOString(), period_to: new Date(Date.now() + 300_000).toISOString() }, idempotencyKey: 'e8-recon-0000' });
    expect(run.status).toBe(202);
    await until('la corrida termina', async () => (await backoffice(stack, 'GET', `/reconciliation_runs/${(run.json as { id: string }).id}`)).json as { status: string }, (r) => r.status !== 'running', 60_000, 250);
    expect((await connectorEvents(stack, main.id)).map((e) => e.data.status)).toEqual(events.map((e) => e.data.status));
    expect(events.filter((e) => e.data.status === 'captured')).toHaveLength(1);
    expect((await ledgerOfCapture(stack, merchant.merchantId, main.id)).captureLinesOnPending).toBe(1);
  });

  it('CONCILIACIÓN (P2): la línea del extracto cruza con el asiento de la captura; la corrida termina sin excepciones y no mueve el ledger', async () => {
    const view = ledgerView(stack);
    const before = await Promise.all([`merchant:${merchant.merchantId}:pending`, 'platform:fees', `connector:${CONNECTOR}:clearing`].map((a) => view.balance(a)));
    const started = await backoffice(stack, 'POST', '/reconciliation_runs', { json: { connector: CONNECTOR, period_from: new Date(startedAt.getTime() - 60_000).toISOString(), period_to: new Date(Date.now() + 300_000).toISOString() }, idempotencyKey: 'e8-recon-0001' });
    expect(started.status).toBe(202);
    const run = await until('la corrida termina', async () => (await backoffice(stack, 'GET', `/reconciliation_runs/${(started.json as { id: string }).id}`)).json as { status: string; matched_count: number; exception_count: number }, (r) => r.status !== 'running', 60_000, 250);
    // Con `payment_intent_id` en la línea: 1 cruzada, 0 excepciones. Sin el campo, la línea trae la referencia de la TRANSFERENCIA, no cruza y sale una excepción (FLUJOS-E4-E8.md).
    expect(run).toMatchObject({ status: 'completed', exception_count: 0 });
    expect(run.matched_count).toBeGreaterThanOrEqual(1);
    expect(await Promise.all([`merchant:${merchant.merchantId}:pending`, 'platform:fees', `connector:${CONNECTOR}:clearing`].map((a) => view.balance(a)))).toEqual(before);
    expect(((await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json as { data: unknown[] }).data).toEqual([]);
  });

  it('IMPORTE DISTINTO: un crédito con la referencia correcta pero otro importe NO captura el cobro; queda a la vista como excepción para una persona', async () => {
    const created = await createBankTransferIntent(BANK_TRANSFER_GROSS, 'e8-intent-wrong-0001');
    expect(created.status).toBe(201);
    wrong = { id: created.intent.id, reference: created.intent.next_action!.bank_transfer!.reference };
    await payerTransfersToBank(stack, { reference: wrong.reference, amountMinor: BANK_TRANSFER_WRONG_AMOUNT });

    const started = await backoffice(stack, 'POST', '/reconciliation_runs', { json: { connector: CONNECTOR, period_from: new Date(startedAt.getTime() - 60_000).toISOString(), period_to: new Date(Date.now() + 300_000).toISOString() }, idempotencyKey: 'e8-recon-0002' });
    await until('la corrida termina', async () => (await backoffice(stack, 'GET', `/reconciliation_runs/${(started.json as { id: string }).id}`)).json as { status: string }, (r) => r.status !== 'running', 60_000, 250);
    const open = (await backoffice(stack, 'GET', '/reconciliation_exceptions?status=open')).json as { data: { kind: string; statement_amount_minor: number | null; ledger_amount_minor: number | null }[] };
    // La línea existe en el banco y el ledger no tiene nada para esa referencia: `missing_in_ledger`, por el importe que trae el extracto.
    expect(open.data).toHaveLength(1);
    expect(open.data[0]).toMatchObject({ kind: 'missing_in_ledger', statement_amount_minor: BANK_TRANSFER_WRONG_AMOUNT, ledger_amount_minor: null });

    expect((await api.getIntent(wrong.id)).status).toBe('requires_action');
    expect(await ledgerOfCapture(stack, merchant.merchantId, wrong.id)).toMatchObject({ captureLinesOnPending: 0 });
    expect((await awaitEvents(stack, 'PAY_SETTLEMENT', 'pay-settlement.reconciliation.exception.opened', (e) => e.data.kind === 'missing_in_ledger' && e.data.statement_line_ref !== undefined)).length).toBeGreaterThanOrEqual(1);
  });
});
