import { serviceDb } from '../lib/db.ts';
import { readStream } from '../lib/events.ts';
import { ledgerOfCapture, publicApi, type PublicIntent } from '../lib/flow.ts';
import { waitFor } from '../lib/process.ts';
import { MerchantReceiver } from '../lib/receiver.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E1 completo SIN intervención manual (P4.H4.M4, DoD): el QR que emite la pasarela (pay-qr REAL, vía pay-edge → pay-payments → pay-connectors) lo paga el PAGADOR SIMULADO
 * de `pay-mockbank` (`POST /sandbox/payer/pay`, lo que hace la app bancaria de quien paga), y el cobro termina `succeeded` por el callback FIRMADO que entrega el banco a
 * `pay-connectors`. La prueba solo crea el intento por la API pública, toma el QR de la respuesta, lo paga con el pagador y espera por condición: no dispara ningún callback
 * ni llama a ninguna ruta interna del flujo del cobro.
 *
 * Único ajuste del arnés: `MOCKBANK_PAYER_MODE=manual` (entorno de pay-mockbank). En el modo `auto` (por defecto) el banco paga solo según el escenario y el pagador no tendría nada que
 * hacer; en `manual` el cobro queda `requires_action` hasta que alguien paga el QR (D-P4-46). Doble declarado: `pay-mockbank` es el banco simulado, no uno real.
 *
 * Correcto: QR → pago del pagador → succeeded, ledger 97,00/3,00 con UN asiento, `payment_intent.succeeded` UNA vez en el bus y UN webhook firmado al receptor.
 * Límite: repetir el pago del mismo QR no duplica nada; un QR con otro importe (con CRC válido o roto) no se paga; un QR vencido no se paga.
 * Inválido: un QR que el banco no conoce, un texto que no es EMV, una identidad ajena y la falta de identidad: nada se mueve y el cobro sigue esperando al pagador.
 */
const GROSS = 10_000;
const FEE = 300;
const NET = GROSS - FEE;

/** CRC-16/CCITT-FALSE del EMVCo MPM (la misma cuenta que valida pay-qr). Independiente del producto: es el oráculo para fabricar un QR con otro importe. */
function crc16(text: string): string {
  let crc = 0xffff;
  for (const char of Buffer.from(text, 'utf8')) {
    crc ^= char << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Reemplaza el importe (campo 54) de un QR EMVCo y recalcula el CRC (campo 63): un QR bien formado pero que el banco nunca vio. */
function withAmount(payload: string, amount: string, recomputeCrc: boolean): string {
  let at = 0;
  let out = '';
  while (at < payload.length - 8) {
    const tag = payload.slice(at, at + 2);
    const length = Number(payload.slice(at + 2, at + 4));
    const value = payload.slice(at + 4, at + 4 + length);
    out += tag === '54' ? `54${String(amount.length).padStart(2, '0')}${amount}` : `${tag}${String(length).padStart(2, '0')}${value}`;
    at += 4 + length;
  }
  const body = `${out}6304`;
  return recomputeCrc ? `${body}${crc16(body)}` : `${body}${payload.slice(-4)}`;
}

describe('E1 completo — el pagador simulado paga el QR de la pasarela', () => {
  let stack: Stack;
  let merchant: SeededMerchant;
  let receiver: MerchantReceiver;
  let api: ReturnType<typeof publicApi>;
  let secret: string;

  const payer = (qrPayload: unknown, from = 'pay-mockbank') => stack.callAs(from, 'pay-mockbank', 'POST', '/sandbox/payer/pay', { json: { qr_payload: qrPayload }, payMode: null });
  const qrOf = (intent: PublicIntent): string => {
    const qr = intent.next_action?.qr?.payload;
    if (!qr) throw new Error(`el intento ${intent.id} no trae QR: ${JSON.stringify(intent.next_action)}`);
    return qr;
  };
  /** Crea el intento por la API pública y espera (condición) a que traiga su QR. */
  async function newQrIntent(key: string, amount = GROSS, extra: Record<string, unknown> = {}) {
    const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { authorization: `Bearer ${merchant.token}`, 'idempotency-key': key }, json: { amount_minor: amount, currency: 'BOB', payment_method: { type: 'qr' }, ...extra } });
    expect(res.status).toBe(201);
    const intent = await until(`el intento ${(res.json as PublicIntent).id} trae su QR`, () => api.getIntent((res.json as PublicIntent).id), (i) => i.next_action?.qr?.payload !== undefined, 30_000, 250);
    return intent;
  }
  const chargeOf = async (intentId: string) => (await serviceDb(stack, 'connectors', (db) => db.query('SELECT id FROM connector_charges WHERE payment_intent_id = $1', [intentId]))).rows[0]!.id as string;
  const callbacksOf = async (chargeId: string) => (await serviceDb(stack, 'mockbank', (db) => db.query('SELECT status, delivered_at IS NOT NULL AS delivered FROM mb_callbacks WHERE reference = $1 ORDER BY id', [chargeId]))).rows as { status: string; delivered: boolean }[];
  const succeededEvents = (intentId: string) => readStream(stack, 'PAY_PAYMENTS', 'pay-payments.payment_intent.succeeded', (e) => e.data.payment_intent_id === intentId);
  const webhooks = (intentId: string) =>
    [...receiver.accepted.values()].filter((a) => a.path === '/hook-e1-payer').map((a) => JSON.parse(a.body) as { type: string; data: { object: { payment_intent_id: string } } }).filter((e) => e.type === 'payment_intent.succeeded' && e.data.object.payment_intent_id === intentId);

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, mockbank: true, envOverrides: { 'pay-mockbank': { MOCKBANK_PAYER_MODE: 'manual' } } });
    merchant = await seedMerchant(stack, { label: 'COMERCIO E1 PAGADOR (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    api = publicApi(stack, merchant);
    receiver = new MerchantReceiver({ port: stack.receiver.port, certFile: stack.receiver.certFile, keyFile: stack.receiver.keyFile });
    await receiver.listen();
    const endpoint = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', {
      headers: { authorization: `Bearer ${merchant.token}`, 'idempotency-key': 'e1-payer-endpoint-0001' },
      json: { url: `https://127.0.0.1:${stack.receiver.port}/hook-e1-payer`, enabled_events: ['payment_intent.succeeded'] },
    });
    expect(endpoint.status).toBe(201);
    secret = (endpoint.json as { secret: string }).secret;
    receiver.route('/hook-e1-payer', { secret, mode: 'up' });
  }, 600_000);
  afterAll(async () => {
    await receiver?.close();
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('CORRECTO: el QR de la API pública lo paga el pagador simulado y el cobro termina succeeded por el callback firmado del banco, con 97,00/3,00, UN asiento, UN evento y UN webhook firmado', async () => {
    const intent = await newQrIntent('e1-payer-intent-0001');
    expect(intent).toMatchObject({ status: 'requires_action', amount_minor: GROSS, fee_minor: FEE, net_minor: NET });
    expect(intent.next_action).toMatchObject({ type: 'display_qr' });
    expect(qrOf(intent)).toMatch(/^000201.*6304[0-9A-F]{4}$/);
    // Mientras nadie paga, el cobro espera: no hay asiento ni callback.
    const chargeId = await chargeOf(intent.id);
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ captureLinesOnPending: 0, debits: 0 });
    expect(await callbacksOf(chargeId)).toEqual([]);

    // El pagador simulado paga el QR (lo decodifica con pay-qr real: CRC, moneda 068 e importe).
    const paid = await payer(qrOf(intent));
    expect(paid.status).toBe(200);
    expect(paid.json).toMatchObject({ charge_reference: chargeId, status: 'captured', amount_minor: GROSS, already_paid: false });

    // Desde acá nadie interviene: el banco entrega el callback firmado a pay-connectors y el intento llega a succeeded.
    const settled = await api.settle(intent.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ pending: NET, fees: FEE, debits: GROSS, credits: GROSS, captureLinesOnPending: 1 });
    expect((await api.balance()).body.pending_minor).toBeGreaterThanOrEqual(NET);
    // El callback salió del banco (fila de su cola, entregada), y pay-connectors lo publicó como captured.
    expect(await until('el banco entregó su callback', () => callbacksOf(chargeId), (rows) => rows.length > 0 && rows.every((r) => r.delivered), 30_000, 250)).toEqual([{ status: 'captured', delivered: true }]);
    expect((await readStream(stack, 'PAY_CONNECTORS', 'pay-connectors.connector.transaction.status_changed', (e) => e.data.payment_intent_id === intent.id)).some((e) => e.data.status === 'captured')).toBe(true);
    // Bus y webhook: UNA vez cada uno (el receptor verifica la firma Standard Webhooks con el secreto del endpoint: lo que `accepted` guarda llegó firmado).
    expect(await succeededEvents(intent.id)).toHaveLength(1);
    expect((await waitFor(async () => webhooks(intent.id).length > 0, 60_000)).ok).toBe(true);
    expect(webhooks(intent.id)).toHaveLength(1);
    expect(receiver.log.filter((l) => l.path === '/hook-e1-payer' && l.outcome !== 'ok' && l.outcome !== 'duplicate')).toEqual([]); // ninguna entrega con firma inválida
  });

  it('LÍMITE: pagar OTRA VEZ el mismo QR no duplica nada (already_paid, un solo callback, un solo asiento, un solo evento, un solo webhook)', async () => {
    const intent = await newQrIntent('e1-payer-intent-0002');
    const chargeId = await chargeOf(intent.id);
    expect((await payer(qrOf(intent))).json).toMatchObject({ already_paid: false });
    expect((await api.settle(intent.id)).status).toBe('succeeded');
    expect((await waitFor(async () => webhooks(intent.id).length > 0, 60_000)).ok).toBe(true);

    for (let n = 0; n < 3; n += 1) {
      const again = await payer(qrOf(intent));
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ charge_reference: chargeId, already_paid: true, amount_minor: GROSS });
    }
    expect((await callbacksOf(chargeId)).map((c) => c.status)).toEqual(['captured']); // el banco no programó ningún callback más
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ debits: GROSS, credits: GROSS, captureLinesOnPending: 1 });
    expect(await succeededEvents(intent.id)).toHaveLength(1);
    expect(webhooks(intent.id)).toHaveLength(1);
  });

  it('LÍMITE: un QR con OTRO importe no se paga: con el CRC recalculado el banco no lo conoce (404 qr_not_registered) y con el CRC roto el pagador lo rechaza (422 crc_invalid); el cobro sigue esperando', async () => {
    const intent = await newQrIntent('e1-payer-intent-0003');
    const original = qrOf(intent);
    const cheaper = withAmount(original, '1.00', true);
    expect(cheaper).not.toBe(original);
    const unknown = await payer(cheaper);
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ code: 'qr_not_registered' });
    const broken = await payer(withAmount(original, '1.00', false));
    expect(broken.status).toBe(422);
    expect(JSON.stringify(broken.json)).toContain('crc_invalid');
    expect(await api.getIntent(intent.id)).toMatchObject({ status: 'requires_action' });
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ captureLinesOnPending: 0, debits: 0 });
    expect(await callbacksOf(await chargeOf(intent.id))).toEqual([]);
    // Control positivo: el QR verdadero sí se paga y el cobro termina por su monto, no por el del QR alterado.
    expect((await payer(original)).status).toBe(200);
    expect(await api.settle(intent.id)).toMatchObject({ status: 'succeeded', amount_minor: GROSS });
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ pending: expect.any(Number), debits: GROSS, credits: GROSS, captureLinesOnPending: 1 });
  });

  it('LÍMITE: un QR VENCIDO no se paga (409 invalid_state): el banco lo da por vencido al llegar expires_at y el cobro no llega a succeeded ni asienta nada', async () => {
    const intent = await newQrIntent('e1-payer-intent-0004', GROSS, { expires_in_seconds: 60 });
    const chargeId = await chargeOf(intent.id);
    const bankStatus = () => stack.callAs('pay-connectors', 'pay-mockbank', 'GET', `/sandbox/charges/${chargeId}`, { payMode: 'test' });
    expect((await bankStatus()).json).toMatchObject({ status: 'pending' });
    await until('el banco da el cobro por vencido', async () => (await bankStatus()).json as { status: string }, (s) => s.status === 'expired', 120_000, 1_000);
    const late = await payer(qrOf(intent));
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ code: 'invalid_state' });
    expect(await callbacksOf(chargeId)).toEqual([]);
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ captureLinesOnPending: 0, debits: 0 });
    expect((await api.getIntent(intent.id)).status).not.toBe('succeeded');
    expect(await succeededEvents(intent.id)).toHaveLength(0);
  }, 240_000);

  it('INVÁLIDO: un QR que el banco no conoce, un texto que no es EMV y un campo ausente se rechazan sin efecto', async () => {
    const intent = await newQrIntent('e1-payer-intent-0005');
    const stranger = withAmount(qrOf(intent), '250.50', true); // bien formado, nunca registrado
    expect((await payer(stranger)).status).toBe(404);
    const notEmv = await payer('esto-no-es-un-qr-emvco-de-ninguna-clase');
    expect(notEmv.status).toBe(422);
    expect((await payer('corto')).status).toBe(422);
    expect((await stack.callAs('pay-mockbank', 'pay-mockbank', 'POST', '/sandbox/payer/pay', { json: {}, payMode: null })).status).toBe(422);
    expect((await stack.callAs('pay-mockbank', 'pay-mockbank', 'POST', '/sandbox/payer/pay', { json: { qr_payload: qrOf(intent), extra: 1 }, payMode: null })).status).toBe(422);
    expect(await api.getIntent(intent.id)).toMatchObject({ status: 'requires_action' });
    expect(await callbacksOf(await chargeOf(intent.id))).toEqual([]);
    expect(await ledgerOfCapture(stack, merchant.merchantId, intent.id)).toMatchObject({ captureLinesOnPending: 0 });
  });

  it('INVÁLIDO: con la identidad de otro servicio (pay-edge, pay-connectors, pay-payments) o sin identidad el pagador responde 403 y el cobro sigue esperando; con la correcta, termina', async () => {
    const intent = await newQrIntent('e1-payer-intent-0006');
    const qr = qrOf(intent);
    for (const from of ['pay-edge', 'pay-connectors', 'pay-payments']) expect((await payer(qr, from)).status).toBe(403);
    const anonymous = await stack.call('pay-mockbank', 'POST', '/sandbox/payer/pay', { json: { qr_payload: qr } });
    expect([401, 403]).toContain(anonymous.status);
    expect(await api.getIntent(intent.id)).toMatchObject({ status: 'requires_action' });
    expect(await callbacksOf(await chargeOf(intent.id))).toEqual([]);
    expect((await payer(qr)).status).toBe(200); // control positivo
    expect((await api.settle(intent.id)).status).toBe('succeeded');
  });
});
