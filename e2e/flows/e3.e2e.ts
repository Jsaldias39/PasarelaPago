import { BankFaultProxy } from '../lib/fault-proxy.ts';
import { publicApi } from '../lib/flow.ts';
import { readStream } from '../lib/events.ts';
import { serviceDb } from '../lib/db.ts';
import { fundWallet } from '../lib/p5-schedules.ts';
import { refundApi, refundLedger, refundRows } from '../lib/refund-flow.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E3 — «Reembolso parcial con retención y fallo del conector» (P3·P2·P4). Los 12 servicios REALES (con `pay-mockbank` como banco del conector `mock`).
 *
 * DOBLES DECLARADOS (nada de esto es el producto):
 *  - `pay-mockbank` es el banco simulado de la capa sandbox (D-26), no un banco real.
 *  - `BankFaultProxy` (lib/fault-proxy.ts) va entre `pay-connectors` y `pay-mockbank` y produce el fallo AMBIGUO que el banco no sabe producir con reembolsos:
 *    reenvía la orden al banco real (que la EJECUTA) y corta la conexión sin devolver la respuesta. El fallo DEFINITIVO es el del propio banco (`PUT /sandbox/admin/down`).
 *  - El saldo disponible del comercio sale de un asiento de apertura SINTÉTICO (`fundWallet`, de P5): todavía no hay corte que pase `pending` a `available` en este flujo.
 *  - Tiempos del arnés (solo entorno de `pay-payments`): espera del aviso 3 s, consulta cada 1 s, 2 intentos por actividad y reintento lento cada 1 s (por defecto 30 s).
 *
 * Qué prueba (correcto / límite / inválido), siempre `UI→request→response→persistencia` hasta el ledger, el banco y el bus, no solo el 201:
 *  - correcto: un cobro capturado de Bs 100,00 y un reembolso PARCIAL de Bs 40,00: retención en el ledger → orden al banco → confirmación de la retención; el
 *    dinero sale del disponible UNA vez y quedan 60,00 por reembolsar.
 *  - límite (regla 11): el banco ejecuta el reembolso y la respuesta se pierde (corte). El reembolso sigue `pending`, la retención NO se anula, se deja constancia para una
 *    persona, y todos los reintentos usan la MISMA referencia `cr_…`. Al volver la red termina `succeeded` con UNA fila en el conector, UNA en el banco y UN asiento.
 *  - fallo DEFINITIVO del conector (`502 connector_unavailable`, banco caído), en el contrato de pay-connectors: la 1ª orden no tiene efecto (fila `failed`, el banco sin nada), repetirla con la
 *    misma clave mientras el banco sigue caído devuelve el MISMO 502 y, vuelto el banco, se ejecuta UNA vez. El mismo fallo de punta a punta por la API pública (`failed` + retención anulada)
 *    está en e2e/flows/e3-fallo-definitivo.e2e.ts (hallazgo 13, corregido en pay-connectors).
 *  - inválido: sin fondos (`insufficient_funds`) el conector ni se toca; más de lo cobrado y sobre un cobro no pagado se rechazan sin mover nada.
 */
describe('E3 — reembolso parcial con retención y fallo del conector', () => {
  let stack: Stack;
  const proxy = new BankFaultProxy();

  beforeAll(async () => {
    await proxy.listen();
    stack = await startStack({
      tolerateFailures: false,
      mockbank: true,
      envOverrides: {
        'pay-connectors': { MOCKBANK_URL: proxy.url },
        'pay-payments': { REFUND_WAIT_MS: '3000', STATUS_INQUIRY_MS: '1000', ACTIVITY_MAX_ATTEMPTS: '2', ACTIVITY_INITIAL_MS: '200', ACTIVITY_MAX_MS: '500', ACTIVITY_SLOW_RETRY_MS: '1000' },
      },
    });
    proxy.setTarget(stack.url('pay-mockbank'));
  }, 600_000);
  afterAll(async () => {
    try {
      if (stack) await bank().down(false).catch(() => undefined);
    } finally {
      await proxy.close();
      if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
    }
  });

  const bank = () => ({
    down: (value: boolean) => stack.callAs('pay-mockbank', 'pay-mockbank', 'PUT', '/sandbox/admin/down', { json: { down: value } }),
  });
  const ledger = () => refundLedger(stack);
  const refundSubject = (type: string) => `pay-payments.refund.${type}`;
  const busRefundEvents = async (type: 'created' | 'succeeded' | 'failed', refundId: string) => readStream(stack, 'PAY_PAYMENTS', refundSubject(type), (e) => e.data.refund_id === refundId);

  /** Un comercio nuevo con un cobro QR de Bs 100,00 `succeeded` (banco simulado, escenario …00) y `availableMinor` en su saldo disponible. */
  async function chargedMerchant(label: string, availableMinor: number): Promise<{ merchant: SeededMerchant; intentId: string; refunds: ReturnType<typeof refundApi>; available: string }> {
    const merchant = await seedMerchant(stack, { label: `COMERCIO E3 ${label} (SINTÉTICO)` });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const api = publicApi(stack, merchant);
    const created = await api.createQrIntent(10_000, `e3-${label}-intent-0001`);
    expect(created.status).toBe(201);
    const settled = await api.settle(created.intent.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });
    if (availableMinor > 0) await fundWallet(stack, merchant.merchantId, availableMinor, 'refund_opening');
    return { merchant, intentId: created.intent.id, refunds: refundApi(stack, merchant), available: `merchant:${merchant.merchantId}:available` };
  }

  beforeEach(() => {
    proxy.mode = 'pass';
  });

  it('el stack incluye al banco simulado, sano', async () => {
    expect(stack.services['pay-mockbank']).toMatchObject({ started: true, healthy: true, error: undefined });
    const probe = await stack.callAs('pay-connectors', 'pay-mockbank', 'GET', '/sandbox/probe', { payMode: 'test' });
    expect(probe.status).toBe(200);
    // Que pay-connectors hable con el banco A TRAVÉS del proxy lo prueba cada test de abajo: el cobro QR se crea contra el banco y el reembolso queda en `recordsOf(...)`.
  });

  it('CORRECTO: reembolso parcial de Bs 40,00 sobre Bs 100,00: retención, orden al banco, confirmación; el dinero sale UNA vez y quedan 60,00 por reembolsar', async () => {
    const { intentId, refunds, available } = await chargedMerchant('correcto', 20_000);
    expect(await ledger().balance(available)).toEqual({ available: 20_000, pendingDebits: 0 });

    const created = await refunds.create(intentId, 4_000, 'e3-correcto-refund-0001');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: 'refund', payment_intent: intentId, amount_minor: 4_000 });
    const refundId = created.body.id;
    const done = await refunds.settle(refundId);
    expect({ status: done.status, failure: done.failure_code }).toEqual({ status: 'succeeded', failure: null });
    // Persistencia: GET independiente (recarga) con el mismo resultado.
    expect(await refunds.get(refundId)).toMatchObject({ id: refundId, status: 'succeeded', amount_minor: 4_000 });

    const rows = await refundRows(stack, refundId);
    expect(rows.payment).toHaveLength(1);
    expect(rows.payment[0]).toMatchObject({ status: 'succeeded', amount_minor: '4000' });
    const holdId = rows.payment[0]!.ledger_hold_id!;
    expect(await ledger().hold(holdId)).toMatchObject({ status: 'posted', business_ref: `${refundId}:refund`, debit_account: available, amount_minor: 4_000, posted_amount_minor: 4_000 });
    // Ledger: el disponible bajó EXACTAMENTE 40,00, no queda retención viva y hay UN débito confirmado con la partida doble en el clearing del conector.
    expect(await ledger().balance(available)).toEqual({ available: 16_000, pendingDebits: 0 });
    const debit = await ledger().linesOfRef(available, `${refundId}:refund`);
    expect(debit.map((l) => [l.direction, l.amount_minor])).toEqual([['debit', 4_000]]);
    expect((await ledger().linesOfRef('connector:mock:clearing', `${refundId}:refund`)).map((l) => [l.direction, l.amount_minor])).toEqual([['credit', 4_000]]);
    // Conector y banco: UNA fila cada uno, con el mismo importe, y el banco recibió la orden con la referencia `cr_…` del conector.
    expect(rows.connector).toHaveLength(1);
    expect(rows.connector[0]).toMatchObject({ status: 'succeeded', amount_minor: '4000', idempotency_key: `${refundId}:refund` });
    expect(rows.bank).toEqual([{ reference: rows.connector[0]!.id, amount_minor: '4000' }]);
    expect(proxy.recordsOf('POST', '/sandbox/refunds').filter((r) => r.reference === rows.connector[0]!.id).map((r) => r.action)).toEqual(['forwarded']);
    // Bus: created y succeeded exactamente una vez; nunca failed.
    expect(await busRefundEvents('created', refundId)).toHaveLength(1);
    expect(await busRefundEvents('succeeded', refundId)).toHaveLength(1);
    expect(await busRefundEvents('failed', refundId)).toHaveLength(0);

    // Límite: la misma Idempotency-Key repite el MISMO reembolso (no hay otro asiento) y un segundo reembolso que pasa de lo que queda se rechaza sin mover nada.
    const replay = await refunds.create(intentId, 4_000, 'e3-correcto-refund-0001');
    expect({ status: replay.status, id: replay.body.id }).toEqual({ status: 201, id: refundId });
    expect(await ledger().linesOfRef(available, `${refundId}:refund`)).toHaveLength(1);
    const tooMuch = await refunds.create(intentId, 6_001, 'e3-correcto-refund-0002');
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors).toEqual([{ field: 'amount_minor', code: 'exceeds_refundable' }]);
    expect(await ledger().balance(available)).toEqual({ available: 16_000, pendingDebits: 0 });
    // Y los 60,00 que quedan SÍ se pueden reembolsar (el parcial no consumió más de lo suyo).
    const rest = await refunds.create(intentId, 6_000, 'e3-correcto-refund-0003');
    expect(rest.status).toBe(201);
    expect((await refunds.settle(rest.body.id)).status).toBe('succeeded');
    expect(await ledger().balance(available)).toEqual({ available: 10_000, pendingDebits: 0 });
  });

  it('LÍMITE (regla 11): el banco EJECUTA el reembolso y la respuesta se pierde; el reembolso sigue pending con la retención viva, se reintenta con la MISMA referencia y termina succeeded con UN solo asiento', async () => {
    const { intentId, refunds, available } = await chargedMerchant('ambiguo', 20_000);
    proxy.mode = 'cut_after_execute';
    const before = proxy.recordsOf('POST', '/sandbox/refunds').length;

    const created = await refunds.create(intentId, 4_000, 'e3-ambiguo-refund-0001');
    expect(created.status).toBe(201);
    const refundId = created.body.id;
    expect(created.body.status).toBe('pending');

    // Reintentos con la misma referencia mientras la respuesta sigue perdiéndose: ≥ 3 envíos, todos cortados DESPUÉS de que el banco ejecutó.
    const sent = await until('el conector reintentó la orden varias veces', async () => proxy.recordsOf('POST', '/sandbox/refunds').slice(before), (list) => list.length >= 3, 60_000, 250);
    expect(sent.every((r) => r.action === 'cut' && r.upstreamStatus === 200 || r.action === 'cut' && r.upstreamStatus === 201)).toBe(true);
    expect(new Set(sent.map((r) => r.reference)).size).toBe(1);
    const connectorRefundId = sent[0]!.reference!;
    expect(connectorRefundId).toMatch(/^cr_[a-z0-9]{10,40}$/);

    // Constancia para una persona, y NADA se anuló ni se dio por fallido: pending, retención viva, disponible reservado, sin línea confirmada.
    const escalated = await until('queda constancia de la ambigüedad', () => refundRows(stack, refundId), (r) => r.escalations.length > 0, 60_000, 250);
    expect(escalated.escalations.map((e) => e.kind)).toContain('refund_outcome_unknown');
    expect(await refunds.get(refundId)).toMatchObject({ status: 'pending', failure_code: null });
    const holdId = escalated.payment[0]!.ledger_hold_id!;
    expect(await ledger().hold(holdId)).toMatchObject({ status: 'pending', amount_minor: 4_000 });
    expect(await ledger().balance(available)).toEqual({ available: 16_000, pendingDebits: 4_000 });
    expect(await ledger().linesOfRef(available, `${refundId}:refund`)).toEqual([]);
    // El banco EJECUTÓ (una fila) aunque el cliente nunca lo supo: «no hubo respuesta» no es «no pasó».
    expect(escalated.bank).toEqual([{ reference: connectorRefundId, amount_minor: '4000' }]);
    expect(escalated.connector).toHaveLength(1);
    expect(escalated.connector[0]).toMatchObject({ idempotency_key: `${refundId}:refund`, may_have_reached_provider: true });
    expect(await busRefundEvents('failed', refundId)).toHaveLength(0);
    expect(await busRefundEvents('succeeded', refundId)).toHaveLength(0);

    // Vuelve la red: el reintento con la MISMA clave encuentra lo que ya hizo el banco (idempotente) y se confirma la retención.
    proxy.mode = 'pass';
    const done = await refunds.settle(refundId);
    expect({ status: done.status, failure: done.failure_code }).toEqual({ status: 'succeeded', failure: null });
    const rows = await refundRows(stack, refundId);
    expect(rows.connector).toHaveLength(1);
    expect(rows.connector[0]).toMatchObject({ status: 'succeeded', amount_minor: '4000' });
    expect(rows.bank).toEqual([{ reference: connectorRefundId, amount_minor: '4000' }]); // sigue UNA fila en el banco: ningún reintento ejecutó otra vez
    const all = proxy.recordsOf('POST', '/sandbox/refunds').slice(before);
    expect(new Set(all.map((r) => r.reference))).toEqual(new Set([connectorRefundId]));
    expect(all.at(-1)?.action).toBe('forwarded');
    expect(await ledger().hold(holdId)).toMatchObject({ status: 'posted', posted_amount_minor: 4_000 });
    expect(await ledger().balance(available)).toEqual({ available: 16_000, pendingDebits: 0 });
    expect((await ledger().linesOfRef(available, `${refundId}:refund`)).map((l) => [l.direction, l.amount_minor])).toEqual([['debit', 4_000]]); // UN asiento: sin doble entrada
    expect((await ledger().linesOfRef('connector:mock:clearing', `${refundId}:refund`)).map((l) => [l.direction, l.amount_minor])).toEqual([['credit', 4_000]]);
    expect(await busRefundEvents('succeeded', refundId)).toHaveLength(1);
    expect(await busRefundEvents('failed', refundId)).toHaveLength(0);
    expect(await busRefundEvents('created', refundId)).toHaveLength(1);
  });

  it('FALLO DEFINITIVO DEL CONECTOR (contrato de pay-connectors, banco caído): la primera orden responde 502 connector_unavailable SIN efecto; repetirla con la misma clave (banco aún caído) devuelve el MISMO 502 y, vuelto el banco, se ejecuta UNA vez', async () => {
    const { intentId, available } = await chargedMerchant('conector', 20_000);
    const chargeId = (await serviceDb(stack, 'connectors', (db) => db.query('SELECT id FROM connector_charges WHERE payment_intent_id = $1', [intentId]))).rows[0]!.id as string;
    // Se habla con el conector DIRECTO, con la identidad de pay-payments (la única que admite), y con un `re_…` sintético: acá se prueba el contrato del conector,
    // el de pay-payments sobre él está en e2e/flows/e3-fallo-definitivo.e2e.ts (hallazgo 13, corregido en pay-connectors).
    const refundId = 're_e3conector00000000000001';
    const send = () => stack.callAs('pay-payments', 'pay-connectors', 'POST', `/charges/${chargeId}/refunds`, { payMode: 'test', headers: { 'idempotency-key': `${refundId}:refund` }, json: { amount_minor: 4_000, refund_id: refundId }, timeoutMs: 30_000 });
    const rowsOf = () => refundRows(stack, refundId);

    expect((await bank().down(true)).status).toBe(200);
    let connectorRefundId: string;
    try {
      // 1ª orden: el banco responde su 503 exacto ⇒ «no se ejecutó»: 502 connector_unavailable, la reserva se libera y el banco no tiene nada.
      const first = await send();
      expect([first.status, (first.json as { code?: string }).code]).toEqual([502, 'connector_unavailable']);
      const afterFirst = await rowsOf();
      expect(afterFirst.connector).toHaveLength(1);
      expect(afterFirst.connector[0]).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable', idempotency_key: `${refundId}:refund`, may_have_reached_provider: true });
      expect(afterFirst.bank).toEqual([]);
      connectorRefundId = afterFirst.connector[0]!.id;
      // 2ª orden con la MISMA clave y el banco aún caído: la marca `may_have_reached_provider` sigue puesta (es monótona a propósito), pero la fila `failed` +
      // `connector_unavailable` + sin referencia del proveedor PRUEBA que ningún envío previo salió ⇒ el contrato manda el MISMO 502 «sin efecto» (hallazgo 13, ola 3).
      const second = await send();
      expect([second.status, (second.json as { code?: string }).code]).toEqual([502, 'connector_unavailable']);
      const afterSecond = await rowsOf();
      expect(afterSecond.connector).toHaveLength(1); // la misma fila, nunca un segundo `cr_…`
      expect(afterSecond.connector[0]).toMatchObject({ id: connectorRefundId, status: 'failed', failure_code: 'connector_unavailable', may_have_reached_provider: true });
      expect(afterSecond.bank).toEqual([]);
    } finally {
      expect((await bank().down(false)).status).toBe(200);
    }
    // Vuelve el banco: la MISMA clave termina el trabajo y el banco ejecuta UNA vez, con la referencia `cr_…` de siempre.
    const third = await send();
    expect(third.status).toBe(201);
    expect(third.json).toMatchObject({ id: connectorRefundId, status: 'succeeded', refund_id: refundId, amount_minor: 4_000 });
    const final = await rowsOf();
    expect(final.connector.map((c) => [c.id, c.status])).toEqual([[connectorRefundId, 'succeeded']]);
    expect(final.bank).toEqual([{ reference: connectorRefundId, amount_minor: '4000' }]);
    // Repetirla otra vez no ejecuta de nuevo (sigue UNA fila en el banco) y el ledger no se tocó (el conector no mueve dinero del comercio).
    expect((await send()).status).toBe(201);
    expect((await rowsOf()).bank).toHaveLength(1);
    expect(await ledger().balance(available)).toEqual({ available: 20_000, pendingDebits: 0 });
  });

  it('INVÁLIDO: sin fondos disponibles el reembolso falla con insufficient_funds SIN tocar al conector ni al banco, y no deja retención', async () => {
    const { intentId, refunds, available } = await chargedMerchant('sinfondos', 0);
    expect(await ledger().balance(available)).toEqual({ available: 0, pendingDebits: 0 });
    const before = proxy.recordsOf('POST', '/sandbox/refunds').length;
    const created = await refunds.create(intentId, 4_000, 'e3-sinfondos-refund-0001');
    expect(created.status).toBe(201);
    const failed = await refunds.settle(created.body.id);
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    const rows = await refundRows(stack, created.body.id);
    expect(rows.connector).toEqual([]);
    expect(rows.bank).toEqual([]);
    expect(rows.payment[0]!.ledger_hold_id).toBeNull();
    expect(proxy.recordsOf('POST', '/sandbox/refunds')).toHaveLength(before);
    expect(await ledger().balance(available)).toEqual({ available: 0, pendingDebits: 0 });
    expect(await busRefundEvents('failed', created.body.id)).toHaveLength(1);
  });

  it('INVÁLIDO: un cobro que no está pagado no se reembolsa (409), y no se abre retención ni orden al banco', async () => {
    const merchant = await seedMerchant(stack, { label: 'COMERCIO E3 NOPAGADO (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const created = await publicApi(stack, merchant).createQrIntent(10_005, 'e3-nopagado-intent-0001'); // …05: callback perdido, no se paga solo
    expect(created.status).toBe(201);
    const refunds = refundApi(stack, merchant);
    const before = proxy.recordsOf('POST', '/sandbox/refunds').length;
    const res = await refunds.create(created.intent.id, 100, 'e3-nopagado-refund-0001');
    expect([res.status, res.body.code]).toEqual([409, 'invalid_state_transition']);
    expect(proxy.recordsOf('POST', '/sandbox/refunds')).toHaveLength(before);
    expect(await ledger().balance(`merchant:${merchant.merchantId}:available`)).toEqual({ available: 0, pendingDebits: 0 });
  });
});
