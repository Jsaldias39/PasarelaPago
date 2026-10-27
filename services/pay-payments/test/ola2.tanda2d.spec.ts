import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { loadContract, type ContractValidator } from '@pay/testing';
import { newCloudEvent } from '@pay/outbox';
import request from 'supertest';
import { join } from 'node:path';
import { EventHandlers } from '../src/events/handlers';
import { replicasRepo } from '../src/persistence/replicas.repo';
import { CONTRACTS } from './doubles/contracts';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { asMerchant, httpApp } from './helpers/http';
import { key, MC, QR_FEES, seedMerchant, startStack, statusOf, TEST_LEGAL_NAME, waitFor, type Stack } from './helpers/stack';

/** Tanda 2d (D-33): `payer_name` en POST /payment_intents, `legal_name` en merchant.created|activated, y el cobro de punta a punta contra dobles. */
let stack: Stack;
let app: INestApplication;
let publicContract: ContractValidator;
let merchantEvents: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const http = () => request(app.getHttpServer());
const post = (body: unknown, merchantId = MC, k = key()) => http().post('/payment_intents').set(asMerchant(merchantId)).set('idempotency-key', k).send(body as object);
const PAYER = 'Persona Sintetica Dos'; // sintético
const callsFor = (intentId: string) => stack.risk.server.calls.filter((c) => (c.body as { payment_intent_id?: string }).payment_intent_id === intentId);
const screeningOf = (call: { body: unknown }) => (call.body as { screening?: { name: string; entity_type?: string } }).screening;
const keyOf = (call: { headers: Record<string, unknown> }) => String(call.headers['idempotency-key']);
const payerNameOf = async (id: string) => (await stack.db.pool.query('SELECT payer_name FROM payment_intents WHERE id = $1', [id])).rows[0]?.payer_name as string | null;
const intentCount = async () => Number((await stack.db.pool.query('SELECT count(*) AS n FROM payment_intents')).rows[0].n);
let seq = 0;
const nextMerchant = () => `mc_d33merch${String(Date.now()).slice(-6)}${String(seq++).padStart(3, '0')}`;

beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  publicContract = await loadContract(CONTRACTS.publicV1);
  merchantEvents = await loadEventValidators(join(process.cwd(), '../../contracts/asyncapi/merchants-schedules.yaml'));
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.risk.mode = 'allow';
  stack.risk.requireScreening = true;
  stack.risk.sanctions.clear();
  stack.connectors.scenario = 'ok';
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

describe('1 · payer_name en POST /payment_intents (public-v1, D-33)', () => {
  it('correcto · con nombre: 201, se cribe como person con clave propia, el cobro sigue y el nombre NO sale en ninguna respuesta ni evento', async () => {
    const body = { ...QR, payer_name: PAYER };
    expect(publicContract.validateRequest({ method: 'POST', path: '/payment_intents', body })).toEqual([]);
    const response = await post(body);
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: response.body })).toEqual([]);
    const calls = callsFor(id);
    expect(calls.map(screeningOf)).toEqual([{ name: TEST_LEGAL_NAME, entity_type: 'business' }, { name: PAYER, entity_type: 'person' }]);
    expect(calls.map(keyOf)).toEqual([`${id}:risk`, `${id}:risk:payer`]);
    expect(stack.connectors.chargeFor(id)).toBeDefined();
    expect(await payerNameOf(id)).toBe(PAYER);
    // Ni la respuesta, ni la lectura, ni el listado, ni la repetición idempotente, ni el outbox lo traen.
    const read = await http().get(`/payment_intents/${id}`).set(asMerchant(MC));
    const list = await http().get('/payment_intents').set(asMerchant(MC));
    const replay = await post(body, MC, 'k-replay-d33-0001');
    const outbox = JSON.stringify((await stack.db.pool.query('SELECT envelope FROM outbox_events WHERE aggregate_id = $1', [id])).rows);
    for (const text of [JSON.stringify(response.body), JSON.stringify(read.body), JSON.stringify(list.body), JSON.stringify(replay.body), outbox]) expect(text).not.toContain(PAYER);
  });

  it('el nombre se BORRA al llegar el intento a un estado terminal (también tras el éxito), y los eventos terminales no lo traen', async () => {
    const id = (await post({ ...QR, payer_name: PAYER })).body.id as string;
    expect(await payerNameOf(id)).toBe(PAYER);
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    expect(await payerNameOf(id)).toBeNull();
    expect(JSON.stringify((await stack.db.pool.query('SELECT envelope FROM outbox_events WHERE aggregate_id = $1', [id])).rows)).not.toContain(PAYER);
  });

  it('límite · 1 y 200 caracteres valen (y el contrato coincide); 201, vacío y en blanco se rechazan con 422 sin repetir el valor ni crear nada', async () => {
    for (const name of ['A', 'B'.repeat(200)]) {
      expect(publicContract.validateRequest({ method: 'POST', path: '/payment_intents', body: { ...QR, payer_name: name } })).toEqual([]);
      expect((await post({ ...QR, payer_name: name })).status).toBe(201);
    }
    const before = await intentCount();
    expect(publicContract.validateRequest({ method: 'POST', path: '/payment_intents', body: { ...QR, payer_name: 'C'.repeat(201) } }).length).toBeGreaterThan(0);
    for (const bad of ['C'.repeat(201), '', '   ']) {
      const response = await post({ ...QR, payer_name: bad });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'validation_failed', errors: [{ field: 'payer_name', code: 'invalid_value' }] });
      expect(JSON.stringify(response.body)).not.toContain('CCCC');
    }
    expect(await intentCount()).toBe(before);
  });

  it('inválido · número, objeto, null y un número de tarjeta (defensa en profundidad tras el pan-guard del borde) → 422; el PAN no se repite', async () => {
    const before = await intentCount();
    for (const bad of [42, { first: 'x' }, null, ['x']]) expect((await post({ ...QR, payer_name: bad })).status).toBe(422);
    const pan = await post({ ...QR, payer_name: 'Pago 4111 1111 1111 1111' });
    expect(pan.status).toBe(422);
    expect(pan.body.errors).toEqual([{ field: 'payer_name', code: 'contains_card_number' }]);
    expect(JSON.stringify(pan.body)).not.toContain('4111');
    expect(await intentCount()).toBe(before);
  });

  it('inválido · la misma Idempotency-Key con OTRO payer_name es 422 idempotency_key_reused (no se criba dos veces a personas distintas)', async () => {
    const k = key();
    const first = await post({ ...QR, payer_name: PAYER }, MC, k);
    const other = await post({ ...QR, payer_name: 'Otra Persona Sintetica' }, MC, k);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('idempotency_key_reused');
    expect(callsFor(first.body.id as string).filter((c) => screeningOf(c)?.entity_type === 'person')).toHaveLength(1);
  });

  it('pagador con nombre en la lista de sanciones ⇒ risk_denied sin cargo; invitado sin nombre en la misma corrida ⇒ no se bloquea', async () => {
    stack.risk.sanctions.add('persona sancionada de prueba');
    const denied = (await post({ ...QR, payer_name: 'Persona SANCIONADA de Prueba' })).body;
    expect(denied).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
    expect(stack.connectors.chargeFor(denied.id as string)).toBeUndefined();
    expect(await payerNameOf(denied.id as string)).toBeNull(); // terminal ⇒ borrado
    const guest = (await post(QR)).body;
    expect(guest.status).toBe('requires_action');
  });
});

describe('2 · legal_name en merchant.created|activated (AsyncAPI nuevo)', () => {
  const handlers = () => new EventHandlers(stack.deps, stack.orchestrator);
  const event = (type: 'merchant.created' | 'merchant.activated', merchantId: string, time: Date, legalName?: unknown) => {
    const iso = time.toISOString();
    const data = type === 'merchant.created' ? { merchant_id: merchantId, status: 'pending', created_at: iso } : { merchant_id: merchantId, status: 'active', activated_at: iso };
    return newCloudEvent({ id: randomUUID(), source: '/pay-merchants', type, subject: merchantId, merchantId, time, data: legalName === undefined ? data : { ...data, legal_name: legalName } });
  };
  const feeSchedule = (merchantId: string) =>
    replicasRepo.upsertFeeSchedule(stack.deps.pool, { merchantId, version: 1, currency: 'BOB', channels: QR_FEES, effectiveFrom: new Date(Date.now() - 86_400_000), effectiveTo: null });

  it('correcto · los eventos con y sin legal_name cumplen el AsyncAPI NUEVO; con él el cobro llega a pay-risk con ese nombre y avanza hasta el conector', async () => {
    const merchant = nextMerchant();
    const t0 = Date.now() - 20_000;
    const created = event('merchant.created', merchant, new Date(t0), 'Razon Social Sintetica Uno S.R.L.');
    const activated = event('merchant.activated', merchant, new Date(t0 + 1000), 'Razon Social Sintetica Uno S.R.L.');
    for (const e of [created, activated]) expect(merchantEvents.get(e.type)?.(e)).toEqual([]);
    await handlers().merchantChanged(created);
    await handlers().merchantChanged(activated);
    await feeSchedule(merchant);
    const response = await post(QR, merchant);
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('requires_action');
    const calls = callsFor(response.body.id as string);
    expect(calls).toHaveLength(1);
    expect(screeningOf(calls[0]!)).toEqual({ name: 'Razon Social Sintetica Uno S.R.L.', entity_type: 'business' });
    expect(stack.connectors.chargeFor(response.body.id as string)).toBeDefined();
  });

  it('límite · SIN legal_name (evento válido del contrato) el cobro se deniega: sale sin screening, pay-risk responde review y el intento es risk_denied; sin cargo', async () => {
    const merchant = nextMerchant();
    const created = event('merchant.created', merchant, new Date(Date.now() - 20_000));
    const activated = event('merchant.activated', merchant, new Date(Date.now() - 19_000));
    for (const e of [created, activated]) expect(merchantEvents.get(e.type)?.(e)).toEqual([]);
    await handlers().merchantChanged(created);
    await handlers().merchantChanged(activated);
    await feeSchedule(merchant);
    const response = await post(QR, merchant);
    expect(response.body).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
    const calls = callsFor(response.body.id as string);
    expect(calls).toHaveLength(1);
    expect(screeningOf(calls[0]!)).toBeUndefined();
    expect(stack.connectors.chargeFor(response.body.id as string)).toBeUndefined();
  });

  it('límite · el nombre puede llegar después, en merchant.activated, y desde ese momento el cobro pasa', async () => {
    const merchant = nextMerchant();
    await handlers().merchantChanged(event('merchant.created', merchant, new Date(Date.now() - 20_000)));
    await handlers().merchantChanged(event('merchant.activated', merchant, new Date(Date.now() - 10_000), 'Llego Con La Activacion S.A.'));
    await feeSchedule(merchant);
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, merchant)).toBe('Llego Con La Activacion S.A.');
    expect((await post(QR, merchant)).body.status).toBe('requires_action');
  });

  it('inválido · legal_name de 301 caracteres (el contrato lo rechaza), vacío o no-texto: se ignora (no se trunca ni se inventa) ⇒ el cobro se deniega', async () => {
    const merchant = nextMerchant();
    const long = 'L'.repeat(301);
    expect(merchantEvents.get('merchant.created')?.(event('merchant.created', merchant, new Date(), long)).length).toBeGreaterThan(0);
    expect(merchantEvents.get('merchant.created')?.(event('merchant.created', merchant, new Date(), 'L'.repeat(300)))).toEqual([]);
    const t0 = Date.now() - 20_000;
    for (const [i, bad] of [long, '', '   ', 7].entries()) await handlers().merchantChanged(event('merchant.created', merchant, new Date(t0 + i * 100), bad));
    await handlers().merchantChanged(event('merchant.activated', merchant, new Date(t0 + 1000)));
    await feeSchedule(merchant);
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, merchant)).toBeNull();
    expect((await post(QR, merchant)).body).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
  });
});

describe('3 · cobro exitoso de punta a punta contra dobles', () => {
  it('comercio activo con legal_name + pagador invitado sin nombre + riesgo allow ⇒ 201 con QR, cargo en el conector, una sola evaluación, y al capturarse el intento llega a succeeded con su asiento en el ledger', async () => {
    const response = await post(QR);
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    expect(response.body).toMatchObject({ status: 'requires_action', amount_minor: 10000, fee_minor: 300, net_minor: 9700, next_action: { type: 'display_qr' } });
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: response.body })).toEqual([]);
    const calls = callsFor(id);
    expect(calls).toHaveLength(1);
    expect(screeningOf(calls[0]!)).toEqual({ name: TEST_LEGAL_NAME, entity_type: 'business' });
    expect(calls.some((c) => screeningOf(c)?.entity_type === 'person')).toBe(false); // el invitado no se cribó ni bloqueó
    const charge = stack.connectors.chargeFor(id)!;
    expect(charge).toBeDefined();
    stack.connectors.setChargeStatus(charge.id, 'succeeded');
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    const row = (await stack.db.pool.query('SELECT status, failure_code, ledger_transfer_id, payer_name FROM payment_intents WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'succeeded', failure_code: null, payer_name: null });
    expect(row.ledger_transfer_id).toBeTruthy();
    const read = await http().get(`/payment_intents/${id}`).set(asMerchant(MC));
    expect(publicContract.validateResponse({ method: 'GET', path: '/payment_intents/{id}', status: 200, body: read.body })).toEqual([]);
  });
});
