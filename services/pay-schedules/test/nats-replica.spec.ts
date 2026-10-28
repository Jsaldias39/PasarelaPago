import { randomBytes, randomUUID } from 'node:crypto';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { AckPolicy, connect, headers, type NatsConnection } from 'nats';
import { ensureStream } from '@pay/outbox';
import { MerchantReplicaConsumer } from '../src/replica/replica.consumer';
import { loadScheduleSettings } from '../src/settings';
import { createTestContext, EVENTS, type TestContext } from './support/app';
import { newMerchant, rows } from './support/http';

/**
 * El consumidor de `merchant.*` contra un NATS REAL (el del stack local, puerto 54222) con eventos construidos desde los EJEMPLOS del
 * AsyncAPI vigente (`contracts/asyncapi/merchants-schedules.yaml`), validados contra su esquema antes de publicarse.
 * Usa un stream y unos temas PROPIOS de la prueba (prefijo único) para no mezclarse con `PAY_MERCHANTS` ni con otros carriles.
 * NO crea mandatos ni ejecuta pagos: el relé del outbox (encendido por `natsUrl`) publicaría esos eventos en el stream REAL `PAY_SCHEDULES`.
 * Que el ejecutor respeta la réplica ya lo prueban executor.spec.ts y replica.spec.ts.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const suffix = randomBytes(4).toString('hex');
const PREFIX = `p5t${suffix}`;
const STREAM = `P5T_${suffix.toUpperCase()}`;
const DURABLE = `p5t-${suffix}`;

let ctx: TestContext;
let nats: NatsConnection;
let examples: Record<string, { payload: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  nats = await connect({ servers: NATS_URL, name: 'p5-test-publisher' });
  await ensureStream(await nats.jetstreamManager(), STREAM, [`${PREFIX}.>`]);
  const doc = (await $RefParser.dereference(EVENTS)) as { components: { messages: Record<string, { examples: { payload: Record<string, any> }[] }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  examples = Object.fromEntries(['MerchantActivated', 'MerchantSuspended', 'MerchantClosed'].map((k) => [k, doc.components.messages[k].examples[0]]));
  ctx = await createTestContext({ natsUrl: NATS_URL, settings: { merchantsStream: STREAM, merchantsDurable: DURABLE, merchantsSubjectPrefix: PREFIX } });
  await ctx.app.get(MerchantReplicaConsumer).ready;
});
afterAll(async () => {
  await ctx.close();
  await (await nats.jetstreamManager()).streams.delete(STREAM).catch(() => undefined);
  await nats.drain();
});

type Kind = 'activated' | 'suspended' | 'closed';
const MESSAGE = { activated: 'MerchantActivated', suspended: 'MerchantSuspended', closed: 'MerchantClosed' } as const;
const AT = { activated: 'activated_at', suspended: 'suspended_at', closed: 'closed_at' } as const;

/** Evento del ejemplo del AsyncAPI con id, comercio y hora propios; se valida contra el esquema del canal ANTES de publicarlo. */
function event(kind: Kind, merchantId: string, at: string, id = randomUUID()): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const base = structuredClone(examples[MESSAGE[kind]].payload);
  base.id = id;
  base.subject = merchantId;
  base.merchantid = merchantId;
  base.time = at;
  base.data.merchant_id = merchantId;
  base.data[AT[kind]] = at;
  return base;
}

async function publish(kind: Kind, raw: unknown, msgId?: string): Promise<void> {
  const h = headers();
  h.set('content-type', 'application/cloudevents+json');
  await nats.jetstream().publish(`${PREFIX}.merchant.${kind}`, new TextEncoder().encode(typeof raw === 'string' ? raw : JSON.stringify(raw)), { msgID: msgId ?? randomUUID(), headers: h });
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  if (!done(value)) throw new Error(`No se cumplió a tiempo: ${what}`);
  return value;
}
const status = async (id: string) => (await rows(ctx, 'SELECT status FROM merchant_replica WHERE merchant_id = $1', [id]))[0]?.status as string | undefined;

describe('consumidor NATS de merchant.* (réplica del estado de comercios)', () => {
  it('los ejemplos del AsyncAPI vigente cumplen su propio esquema (la prueba parte de eventos válidos)', () => {
    for (const kind of ['activated', 'suspended', 'closed'] as Kind[]) {
      expect({ kind, errors: ctx.events.validate(`pay-merchants.merchant.${kind}`, event(kind, newMerchant(), '2026-03-01T10:00:00.000Z')) }).toEqual({ kind, errors: [] });
    }
  });

  it('correcto: activated → suspended → closed por NATS actualiza la réplica, en orden', async () => {
    const id = newMerchant();
    await publish('activated', event('activated', id, '2026-03-01T10:00:00.000Z'));
    expect(await eventually(() => status(id), (s) => s === 'active', 'active')).toBe('active');
    await publish('suspended', event('suspended', id, '2026-03-02T10:00:00.000Z'));
    expect(await eventually(() => status(id), (s) => s === 'suspended', 'suspended')).toBe('suspended');
    await publish('closed', event('closed', id, '2026-03-03T10:00:00.000Z'));
    expect(await eventually(() => status(id), (s) => s === 'closed', 'closed')).toBe('closed');
  });

  it('límite: un evento viejo que llega tarde por el bus no pisa el estado más nuevo', async () => {
    const id = newMerchant();
    await publish('closed', event('closed', id, '2026-03-05T10:00:00.000Z'));
    await eventually(() => status(id), (s) => s === 'closed', 'closed');
    await publish('activated', event('activated', id, '2026-03-01T10:00:00.000Z'));
    await publish('suspended', event('suspended', id, '2026-03-04T10:00:00.000Z'));
    // Un marcador posterior garantiza que los dos anteriores ya se procesaron.
    const marker = newMerchant();
    await publish('activated', event('activated', marker, '2026-03-06T10:00:00.000Z'));
    await eventually(() => status(marker), (s) => s === 'active', 'marcador');
    expect(await status(id)).toBe('closed');
  });

  it('la entrega repetida del MISMO evento (otro Nats-Msg-Id, mismo id de evento) tiene un solo efecto: lo frena el inbox', async () => {
    const id = newMerchant();
    const eventId = randomUUID();
    const first = event('activated', id, '2026-03-01T10:00:00.000Z', eventId);
    await publish('activated', first);
    await eventually(() => status(id), (s) => s === 'active', 'active');
    // El mismo id de evento con un contenido que, si se aplicara, cambiaría el estado: el inbox lo descarta.
    const replay = { ...first, type: 'merchant.closed', data: { merchant_id: id, status: 'closed', closed_at: '2026-03-09T10:00:00.000Z' } };
    await publish('closed', replay);
    const marker = newMerchant();
    await publish('activated', event('activated', marker, '2026-03-06T10:00:00.000Z'));
    await eventually(() => status(marker), (s) => s === 'active', 'marcador');
    expect(await status(id)).toBe('active');
    expect((await rows(ctx, `SELECT 1 FROM inbox_events WHERE consumer = 'pay-schedules.merchant-replica' AND event_id = $1`, [eventId]))).toHaveLength(1);
  });

  it.each([
    ['JSON roto', '{"specversion": "1.0", '],
    ['otro emisor', (e: Record<string, any>) => ({ ...e, source: '/pay-otro' })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['id que no es UUID', (e: Record<string, any>) => ({ ...e, id: 'no-uuid' })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['comercio mal formado', (e: Record<string, any>) => ({ ...e, data: { ...e.data, merchant_id: 'MC_1' } })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['hora inválida', (e: Record<string, any>) => ({ ...e, data: { ...e.data, activated_at: 'ayer' } })], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])('inválido: %s se descarta (term) sin tocar la réplica y SIN bloquear a los siguientes', async (_name, mutate) => {
    const bad = newMerchant();
    const base = event('activated', bad, '2026-03-01T10:00:00.000Z');
    await publish('activated', typeof mutate === 'string' ? mutate : mutate(base));
    const next = newMerchant();
    await publish('activated', event('activated', next, '2026-03-01T10:00:00.000Z'));
    await eventually(() => status(next), (s) => s === 'active', 'el siguiente evento sigue procesándose');
    expect(await status(bad)).toBeUndefined();
  });

  it('el consumidor durable no deja mensajes pendientes sin confirmar tras procesar', async () => {
    const jsm = await nats.jetstreamManager();
    const info = await eventually(() => jsm.consumers.info(STREAM, DURABLE), (i) => i.num_pending === 0 && i.num_ack_pending === 0, 'sin pendientes');
    expect(info.config.durable_name).toBe(DURABLE);
    expect(info.config.filter_subjects).toEqual([`${PREFIX}.merchant.activated`, `${PREFIX}.merchant.suspended`, `${PREFIX}.merchant.closed`]);
  });

  it('el nombre durable POR DEFECTO lo acepta JetStream (correcto) y uno con punto lo rechaza (inválido): lo que rompió el primer E5 real', async () => {
    const jsm = await nats.jetstreamManager();
    const base = { PAY_MODE: 'sandbox', LEDGER_URL: 'http://ledger:3000', RETRY_DELAYS_SECONDS: '60' };
    const byDefault = loadScheduleSettings(base).merchantsDurable;
    await jsm.consumers.add(STREAM, { durable_name: byDefault, ack_policy: AckPolicy.Explicit, filter_subjects: [`${PREFIX}.merchant.activated`] });
    expect((await jsm.consumers.info(STREAM, byDefault)).config.durable_name).toBe(byDefault);
    await jsm.consumers.delete(STREAM, byDefault);
    await expect(jsm.consumers.add(STREAM, { durable_name: 'pay-schedules.merchant-replica', ack_policy: AckPolicy.Explicit })).rejects.toThrow(/durable name cannot contain '\.'/);
  });
});
