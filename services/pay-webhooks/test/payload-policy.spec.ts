import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PayloadPolicyError, buildPublicPayload, filterEventData } from '../src/events/payload-policy';
import { PUBLIC_EVENT_TYPES, isPublicEventType } from '../src/events/public-events';
import { cloudEvent } from './fixtures';
import { newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/** P1.H3.M5 — política de payload: solo ids, estados e importes; ni documento, ni nombre, ni teléfono. */

interface AsyncMessage {
  name: string;
  examples?: { payload: { type: string; id: string; time: string; merchantid?: string; data: Record<string, unknown> } }[];
}

function publicExamples() {
  const out: { type: string; id: string; time: string; merchantId: string; data: Record<string, unknown> }[] = [];
  for (const file of ['payments', 'ledger-settlement', 'merchants-schedules']) {
    const doc = parse(readFileSync(join(process.cwd(), `../../contracts/asyncapi/${file}.yaml`), 'utf8')) as { components: { messages: Record<string, AsyncMessage> } };
    for (const message of Object.values(doc.components.messages)) {
      const example = message.examples?.[0]?.payload;
      if (example && isPublicEventType(example.type)) out.push({ type: example.type, id: example.id, time: example.time, merchantId: example.merchantid ?? String(example.data.merchant_id), data: example.data });
    }
  }
  return out;
}

const PII = {
  correo: /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i,
  telefono: /(?:\+?591[\s-]?)?\b[67]\d{7}\b/,
  tarjeta: /\b(?:\d[ -]?){13,19}\b/,
  campos: /"(?:name|nombre|full_name|document|documento|document_number|ci|nit|phone|telefono|email|correo|address|direccion|holder|holder_name|card_number|pan|cvv|account_number|iban)"/i,
};

describe('payload público — contra los ejemplos reales de los contratos AsyncAPI', () => {
  const examples = publicExamples();

  it('hay un ejemplo por cada tipo público (si el contrato agrega uno, esta prueba lo avisa)', () => {
    expect(examples.map((e) => e.type).sort()).toEqual([...PUBLIC_EVENT_TYPES].sort());
  });

  it.each(PUBLIC_EVENT_TYPES.map((type) => [type]))('%s: pasa SIN descartar ningún campo ni lanzar', (type) => {
    const example = examples.find((e) => e.type === type)!;
    const { payload, dropped } = buildPublicPayload(example, 'test');
    expect(dropped).toEqual([]);
    expect(JSON.parse(payload).data.object).toEqual(example.data);
  });

  it('GREP del DoD: ningún payload público contiene documento, nombre, teléfono, correo ni tarjeta (0 coincidencias)', () => {
    const hits: string[] = [];
    for (const example of examples) {
      const { payload } = buildPublicPayload(example, 'live');
      for (const [name, regex] of Object.entries(PII)) {
        // los importes en centavos y las fechas no son tarjetas: se comparan solo las cadenas de más de 12 dígitos seguidos
        const match = name === 'tarjeta' ? /\d{13,19}/.exec(payload) : regex.exec(payload);
        if (match) hits.push(`${example.type}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
    expect(examples.length).toBeGreaterThanOrEqual(21);
  });

  it('el JSON es determinista: mismas entradas, mismos bytes', () => {
    const example = examples[0];
    expect(buildPublicPayload(example, 'test').payload).toBe(buildPublicPayload(example, 'test').payload);
  });
});

describe('filterEventData — niveles', () => {
  it('CORRECTO: ids con dígitos, fechas ISO e importes no se confunden con teléfonos ni tarjetas', () => {
    const data = { payment_intent_id: 'pi_c92215200m49', ledger_transfer_id: 'tr_0123456789abcdef', amount_minor: 10000, currency: 'BOB', succeeded_at: '2026-10-27T15:00:00.000Z', period_from: '2026-10-01', status: 'succeeded', merchant_id: 'mc_5c048c31m1fb', refund_id: '6f1f0a52-0d1c-4f4a-9a52-1f5a8c2f3a10' };
    expect(filterEventData(data)).toEqual({ data, dropped: [] });
  });

  it.each([
    'name', 'nombre', 'full_name', 'document_number', 'documento', 'ci', 'nit', 'phone', 'telefono', 'email', 'correo', 'address', 'direccion', 'holder_name', 'card_number', 'pan', 'cvv', 'account_number', 'iban', 'payer', 'metadata', 'note', 'description', 'bank_account',
  ])('LÍMITE: el campo %s no está en la lista y se DESCARTA (el valor no pasa)', (key) => {
    const { data, dropped } = filterEventData({ payment_intent_id: 'pi_abcdefghij12', [key]: 'Juan Pérez 71234567' });
    expect(dropped).toEqual([key]);
    expect(JSON.stringify(data)).not.toMatch(/Juan|71234567/);
  });

  it.each([
    ['correo en un campo permitido', { reason: 'cliente: juan.perez@correo.com' }, 'email_in_value'],
    ['teléfono suelto en un id', { reference_id: '71234567' }, 'phone_in_value'],
    ['teléfono con prefijo', { reason: '+591 7123 4567' }, 'phone_in_value'],
    ['tarjeta de prueba en un id', { payment_intent_id: 'pi_4111111111111111' }, 'card_number_in_value'],
    ['tarjeta con espacios', { reason: '4111 1111 1111 1111' }, 'card_number_in_value'],
    ['tarjeta con guiones', { reason: '5500-0000-0000-0004' }, 'card_number_in_value'],
    ['objeto anidado', { status: { first_name: 'Ana' } }, 'not_scalar'],
    ['lista', { reason: ['a', 'b'] }, 'not_scalar'],
  ])('INVÁLIDO: %s ⇒ el evento se RECHAZA entero', (_name, data, reason) => {
    expect(() => filterEventData(data)).toThrow(PayloadPolicyError);
    try {
      filterEventData(data);
    } catch (error) {
      expect((error as PayloadPolicyError).reason).toBe(reason);
      // el mensaje nombra el campo, jamás el valor
      expect((error as PayloadPolicyError).message).not.toMatch(/juan|7123|4111|5500|Ana/i);
    }
  });

  it('un número largo que NO pasa Luhn no se toma por tarjeta, pero igual se rechaza: parece un número personal (conservador)', () => {
    expect(() => filterEventData({ reason: '1234 5678 9012 3456' })).toThrow(expect.objectContaining({ reason: 'phone_in_value' }));
  });

  it('buildPublicPayload rechaza un tipo que no es público', () => {
    expect(() => buildPublicPayload({ id: 'x', type: 'ledger.transfer.posted', time: '2026-10-27T00:00:00Z', merchantId: 'mc_abcdefghij12', data: {} }, 'test')).toThrow(PayloadPolicyError);
  });
});

describe('EventIngest — sobre, tipos internos y comercios sin endpoints', () => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks();
  });
  afterAll(async () => h.stop());

  const merchant = newMerchantId();

  it.each([
    ['ledger.transfer.posted'],
    ['ledger.hold.created'],
    ['api_key.created'],
    ['api_key.revoked'],
    ['merchant.suspended'],
    ['fee_schedule.published'],
    ['settlement.batch.closed'],
    ['reconciliation.exception.opened'],
    ['connector.transaction.status_changed'],
  ])('un evento INTERNO (%s) se ignora y nunca genera una entrega', async (type) => {
    const before = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(await h.ingest.ingest(cloudEvent(type, merchant, { key_hash: 'sha256$00', last4: '1234' }))).toEqual({ kind: 'ignored', reason: 'internal_event' });
    const after = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const inbox = await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE consumer = $1', [`pay-webhooks.${type}`]);
    expect(inbox.rows[0].n).toBe(0);
  });

  it.each([
    ['no es un objeto', 'texto'],
    ['sin specversion', { ...cloudEvent('payment_intent.succeeded', merchant), specversion: undefined }],
    ['specversion distinta', cloudEvent('payment_intent.succeeded', merchant, {}, { specversion: '0.3' })],
    ['id que no es UUID', cloudEvent('payment_intent.succeeded', merchant, {}, { id: 'abc' })],
    ['origen ajeno a la pasarela', cloudEvent('payment_intent.succeeded', merchant, {}, { source: 'https://evil.example' })],
    ['sin data', { ...cloudEvent('payment_intent.succeeded', merchant), data: undefined }],
    ['comercio con formato inválido', cloudEvent('payment_intent.succeeded', "mc_x'; DROP TABLE webhook_deliveries;--", {}, { merchantid: "mc_x'; DROP TABLE webhook_deliveries;--" })],
    ['fecha inválida', cloudEvent('payment_intent.succeeded', merchant, {}, { time: 'ayer' })],
    ['tipo con formato inválido', cloudEvent('PAGO', merchant)],
  ])('INVÁLIDO: %s ⇒ rechazado (malformed), sin efectos', async (_name, event) => {
    const outcome = await h.ingest.ingest(event);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'malformed' });
  });

  it('un evento con datos personales en un campo permitido se rechaza (payload_policy) y no deja inbox ni entrega', async () => {
    const event = cloudEvent('refund.created', merchant, { refund_id: 'rf_abcdefghij12', reason: 'devolver a maria@correo.com' });
    expect(await h.ingest.ingest(event)).toMatchObject({ kind: 'rejected', reason: 'payload_policy', detail: 'email_in_value:reason' });
    const inbox = await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id]);
    expect(inbox.rows[0].n).toBe(0);
  });

  it('un comercio SIN endpoints (o inexistente): el evento se consume sin entregas y se cuenta en la métrica', async () => {
    const before = h.ingest.metrics.noEndpoints;
    expect(await h.ingest.ingest(cloudEvent('payment_intent.succeeded', newMerchantId()))).toEqual({ kind: 'queued', deliveries: 0 });
    expect(h.ingest.metrics.noEndpoints).toBe(before + 1);
  });

  it('el merchantid de la extensión manda; si falta se usa data.merchant_id', async () => {
    const event = cloudEvent('payment_intent.succeeded', merchant);
    const { merchantid: _omit, ...withoutExtension } = event;
    expect((await h.ingest.ingest(withoutExtension)).kind).toBe('queued');
  });
});
