import { randomBytes, randomUUID } from 'node:crypto';
import { connect, type NatsConnection } from 'nats';
import { NatsEventPublisher, OutboxRelay, newCloudEvent, type CloudEvent, type EventPublisher } from '@pay/outbox';
import { EventHandlers } from '../src/events/handlers';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { eventsOf, key, MC, seedMerchant, startDirectIntent, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * P3.H1.M3 · REQ-P3-3: «Dado un `failed` cuando ya está `succeeded`, cuando llega, entonces se marca contradicción, no se sobrescribe y se
 * publica para conciliación humana». Se prueba la cadena completa: evento del conector → handler → fila + evento en el MISMO commit →
 * relé del outbox → JetStream (stream propio de la prueba) → lo que lee el consumidor (pay-settlement).
 */
let stack: Stack;
let nats: NatsConnection;
let validators: Map<string, EventValidator>;
let handlers: EventHandlers;
const prefix = `p3g${randomBytes(4).toString('hex')}`;
const STREAM = prefix.toUpperCase();
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
let seq = 0;
const nextId = () => `pi_g3${String(Date.now()).slice(-7)}${String(seq++).padStart(3, '0')}`;

beforeAll(async () => {
  stack = await startStack();
  validators = await loadEventValidators();
  handlers = new EventHandlers(stack.deps, stack.orchestrator);
  await seedMerchant(stack, MC);
  nats = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:54222' });
  await (await nats.jetstreamManager()).streams.add({ name: STREAM, subjects: [`${prefix}.>`] });
});
afterAll(async () => {
  await (await nats.jetstreamManager()).streams.delete(STREAM).catch(() => undefined);
  await nats.drain();
  await stack.stop();
});

const connectorEvent = (intentId: string, status: string, id: string = randomUUID()): CloudEvent =>
  newCloudEvent({
    id, source: '/pay-connectors', type: 'connector.transaction.status_changed', subject: 'ct_aaaaaaaaaaaa', merchantId: MC,
    data: { connector_transaction_id: 'ct_aaaaaaaaaaaa', connector: 'simulator', kind: 'charge', payment_intent_id: intentId, merchant_id: MC, status, amount_minor: 10000, currency: 'BOB', provider_event_id: randomUUID(), provider_occurred_at: new Date().toISOString(), observed_via: 'callback' },
  });
const contradictions = async (id: string) => (await stack.db.pool.query('SELECT kind, reason, current_status, incoming_status, source_event_id FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows as { kind: string; reason: string; current_status: string; incoming_status: string; source_event_id: string }[];
const outboxContradictions = async (id: string) => (await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.contradiction_detected');
const terminalEvents = async (id: string) => (await eventsOf(stack, id)).filter((e) => /^payment_intent\.(succeeded|failed|canceled|expired)$/.test(e.type));
async function succeeded(): Promise<string> {
  const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
  return id;
}
/** Corre el relé una vez contra el stream de la prueba (mismo subject, con el prefijo de la prueba delante) y devuelve cuántos publicó. */
async function relay(): Promise<number> {
  const inner = new NatsEventPublisher(nats);
  const toTestStream: EventPublisher = { publish: (subject, event) => inner.publish(`${prefix}.${subject}`, event) };
  return new OutboxRelay(stack.servicePool, toTestStream).drainOnce();
}
async function onBus(intentId: string): Promise<Record<string, unknown>[]> {
  const manager = await nats.jetstreamManager();
  const subject = `${prefix}.pay-payments.payment_intent.contradiction_detected`;
  const info = await manager.streams.info(STREAM, { subjects_filter: subject });
  const total = info.state.subjects?.[subject] ?? 0;
  const out: Record<string, unknown>[] = [];
  for (let n = 1; n <= info.state.last_seq; n++) {
    const message = await manager.streams.getMessage(STREAM, { seq: n }).catch(() => undefined);
    if (message?.subject !== subject) continue;
    const event = message.json<{ data: Record<string, unknown> }>();
    if (event.data.payment_intent_id === intentId) out.push(event as unknown as Record<string, unknown>);
  }
  expect(total).toBeGreaterThanOrEqual(out.length);
  return out;
}

describe('REQ-P3-3 · un `failed` sobre un `succeeded` es una contradicción: no se pisa y se publica', () => {
  it('correcto · el estado NO se pisa, queda la fila, sale UN evento válido del AsyncAPI en el mismo commit, y llega al bus con lo que necesita la conciliación', async () => {
    const id = await succeeded();
    const terminalBefore = (await terminalEvents(id)).map((e) => e.type);
    expect(await contradictions(id)).toEqual([]);

    const contradicting = connectorEvent(id, 'failed');
    expect(await handlers.connectorStatusChanged(contradicting)).toBe('processed');

    expect(await statusOf(stack, id)).toBe('succeeded'); // no se sobrescribe
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1); // ni se toca el asiento
    expect(await contradictions(id)).toEqual([{ kind: 'status_conflict', reason: 'charge_captured_to_failed', current_status: 'succeeded', incoming_status: 'failed', source_event_id: contradicting.id }]);
    expect((await terminalEvents(id)).map((e) => e.type)).toEqual(terminalBefore); // sin un segundo evento terminal

    const outbox = await outboxContradictions(id);
    expect(outbox).toHaveLength(1);
    expect(validators.get('payment_intent.contradiction_detected')?.(outbox[0]!.envelope)).toEqual([]);
    expect(outbox[0]!.envelope.data).toMatchObject({ payment_intent_id: id, merchant_id: MC, kind: 'status_conflict', current_status: 'succeeded', incoming_status: 'failed', mode: 'test' });

    await relay();
    const published = await onBus(id);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'payment_intent.contradiction_detected', source: '/pay-payments', subject: id, data: { payment_intent_id: id, kind: 'status_conflict' } });
    // Sin datos de personas: el evento solo lleva identificadores, estados, modo y fecha.
    expect(Object.keys(published[0]!.data as object).sort()).toEqual(['current_status', 'detected_at', 'incoming_status', 'kind', 'merchant_id', 'mode', 'payment_intent_id']);
  });

  it('límite · el MISMO evento reentregado (at-least-once) no duplica la fila ni el evento; dos eventos DISTINTOS son dos hechos; y el relé repetido no republica', async () => {
    const id = await succeeded();
    const contradicting = connectorEvent(id, 'failed');
    expect(await handlers.connectorStatusChanged(contradicting)).toBe('processed');
    expect(await handlers.connectorStatusChanged(contradicting)).toBe('duplicate');
    expect(await handlers.connectorStatusChanged(contradicting)).toBe('duplicate');
    expect(await contradictions(id)).toHaveLength(1);
    expect(await outboxContradictions(id)).toHaveLength(1);

    await handlers.connectorStatusChanged(connectorEvent(id, 'canceled')); // otro hecho contradictorio (otro event id)
    expect(await contradictions(id)).toHaveLength(2);
    expect(await outboxContradictions(id)).toHaveLength(2);

    await relay();
    expect(await relay()).toBe(0); // ya publicados: el relé no los vuelve a enviar
    expect(await onBus(id)).toHaveLength(2);
    expect(await statusOf(stack, id)).toBe('succeeded');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
  });

  it('límite · el orden inverso: dinero `captured` para un intento ya `failed` (riesgo denegado) es contradicción, sin asiento, y también se publica', async () => {
    stack.risk.mode = 'deny';
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000 });
    await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 15_000, 'failed');
    stack.risk.mode = 'allow';
    await handlers.connectorStatusChanged(connectorEvent(id, 'captured'));
    expect(await statusOf(stack, id)).toBe('failed');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect(await contradictions(id)).toMatchObject([{ kind: 'status_conflict', reason: 'captured_for_failed_intent', current_status: 'failed', incoming_status: 'captured' }]);
    const outbox = await outboxContradictions(id);
    expect(outbox).toHaveLength(1);
    expect(validators.get('payment_intent.contradiction_detected')?.(outbox[0]!.envelope)).toEqual([]);
    await relay();
    expect(await onBus(id)).toHaveLength(1);
  });

  it('inválido · lo que NO es contradicción no publica nada: duplicado (`captured` otra vez), obsoleto (`authorized` atrasado), terminales sin dinero que no coinciden, intento desconocido y evento ilegible', async () => {
    const id = await succeeded();
    await handlers.connectorStatusChanged(connectorEvent(id, 'captured')); // duplicado
    await handlers.connectorStatusChanged(connectorEvent(id, 'authorized')); // obsoleto
    expect(await contradictions(id)).toEqual([]);
    expect(await outboxContradictions(id)).toEqual([]);

    const unknown = nextId();
    await handlers.connectorStatusChanged(connectorEvent(unknown, 'failed'));
    expect(await contradictions(unknown)).toEqual([]);

    const poison = connectorEvent(id, 'failed');
    (poison.data as Record<string, unknown>).payment_intent_id = 42;
    await expect(handlers.connectorStatusChanged(poison)).rejects.toThrow();
    expect(await contradictions(id)).toEqual([]);
    expect(await outboxContradictions(id)).toEqual([]);
    expect(await statusOf(stack, id)).toBe('succeeded');
  });

  it('atomicidad · si la transacción cae antes del commit, NI la fila NI el evento existen (sin commit no hay evento)', async () => {
    const id = await succeeded();
    const { contradictionsRepo } = await import('../src/persistence/contradictions.repo');
    const before = (await outboxContradictions(id)).length;
    await expect(stack.deps.tx(async (db) => {
      await contradictionsRepo.record(db, { paymentIntentId: id, currentStatus: 'succeeded', incomingStatus: 'failed', sourceEventId: 'g3-rollback', kind: 'status_conflict', reason: 'x' });
      throw new Error('cae antes del commit');
    })).rejects.toThrow('cae antes del commit');
    expect(await contradictions(id)).toEqual([]);
    expect((await outboxContradictions(id)).length).toBe(before);
  });
});
