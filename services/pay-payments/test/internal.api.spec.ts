import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { loadContract, type ContractValidator } from '@pay/testing';
import { CONTRACTS } from './doubles/contracts';
import { httpApp } from './helpers/http';
import { eventsOf, key, MC, MC2, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

let stack: Stack;
let app: INestApplication;
let contract: ContractValidator;
// Temporal conserva los workflows entre corridas y el id del intento sale de (comercio, mandato, periodo): sin un mandato nuevo por corrida
// el `start` chocaría con el workflow ya completado de una corrida anterior.
const RUN = randomBytes(5).toString('hex');
const SCHEDULES = { 'x-service-id': 'pay-schedules', 'x-pay-mode': 'test' } as const;
const body = (over: Record<string, unknown> = {}) => ({
  source: { kind: 'mandate', id: `md_${RUN}000001`, period: '2026-10' },
  kind: 'obligation',
  payer_merchant_id: MC,
  beneficiary_merchant_id: MC2,
  amount_minor: 30000,
  currency: 'BOB',
  payment_method: { type: 'wallet' },
  ...over,
});
const post = (b: unknown, idempotencyKey = key()) => request(app.getHttpServer()).post('/intents').set(SCHEDULES).set('idempotency-key', idempotencyKey).send(b as object);

beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  contract = await loadContract(CONTRACTS.payments);
  await seedMerchant(stack, MC);
  await seedMerchant(stack, MC2);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});

describe('internal-payments-v1 · cobro por mandato (pay-schedules)', () => {
  it('paga con el saldo del comercio pagador: 201 conforme al contrato, el beneficiario cobra y el intento termina succeeded', async () => {
    stack.ledger.setBalance(`merchant:${MC}:available`, 100000);
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ object: 'payment_intent', kind: 'obligation', payer_merchant_id: MC, beneficiary_merchant_id: MC2, amount_minor: 30000, fee_minor: 0 });
    expect(contract.validateResponse({ method: 'POST', path: '/intents', status: 201, body: response.body })).toEqual([]);
    await waitFor(async () => ((await statusOf(stack, response.body.id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(70000);
    expect(stack.ledger.balance(`merchant:${MC2}:pending`)).toBe(30000);
    const got = await request(app.getHttpServer()).get(`/intents/${response.body.id}`).set(SCHEDULES);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('succeeded');
    expect(contract.validateResponse({ method: 'GET', path: `/intents/${response.body.id}`, status: 200, body: got.body })).toEqual([]);
  });

  it('el mismo mandato y periodo, aunque sea con otra Idempotency-Key, devuelve el MISMO intento (200) y no cobra dos veces', async () => {
    stack.ledger.setBalance(`merchant:${MC}:available`, 100000);
    const mandate = { source: { kind: 'mandate', id: `md_${RUN}000002`, period: '2026-11' } };
    const first = await post(body(mandate));
    const second = await post(body(mandate), key());
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    await waitFor(async () => ((await statusOf(stack, first.body.id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(70000);
    expect(stack.ledger.postedCount(`${first.body.id}:capture`)).toBe(1);
    // 10 peticiones concurrentes para otro periodo: un solo intento.
    const period = { source: { kind: 'mandate', id: `md_${RUN}000002`, period: '2026-12' } };
    const many = await Promise.all(Array.from({ length: 10 }, () => post(body(period), key())));
    // Diagnóstico (misma aserción): si hay más de un valor, el mensaje trae el estado HTTP y el cuerpo de cada respuesta, para clasificar el fallo.
    const ids = new Set(many.map((r) => r.body.id));
    if (ids.size !== 1) throw new Error(`se esperaba UN solo intento y hubo ${ids.size}: ${JSON.stringify(many.map((r) => ({ status: r.status, id: r.body.id, code: r.body.code, detail: r.body.detail })))}`);
    const rows = await stack.db.pool.query(`SELECT count(*)::int AS n FROM payment_intents WHERE source ->> 'id' = 'md_${RUN}000002' AND source ->> 'period' = '2026-12'`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('el mismo mandato y periodo pedido a la vez por dos pagadores distintos: UN solo intento, ninguna respuesta 5xx (carrera contra el índice único del mandato)', async () => {
    stack.ledger.setBalance(`merchant:${MC}:available`, 100000);
    stack.ledger.setBalance(`merchant:${MC2}:available`, 100000);
    const source = { kind: 'mandate', id: `md_${RUN}000009`, period: '2027-02' };
    for (let round = 0; round < 5; round += 1) {
      const roundSource = { ...source, period: `2027-0${round + 1}` };
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => post(body({ source: roundSource }), key())),
        ...Array.from({ length: 4 }, () => post(body({ source: roundSource, payer_merchant_id: MC2, beneficiary_merchant_id: MC }), key())),
      ]);
      expect(results.filter((r) => r.status >= 500).map((r) => ({ status: r.status, code: r.body.code }))).toEqual([]);
      const rows = await stack.db.pool.query(`SELECT count(*)::int AS n FROM payment_intents WHERE source ->> 'id' = $1 AND source ->> 'period' = $2`, [roundSource.id, roundSource.period]);
      expect(rows.rows[0].n).toBe(1);
    }
  });

  it('sin saldo: 422 insufficient_funds y el intento queda failed con su evento; el saldo no cambia', async () => {
    stack.ledger.setBalance(`merchant:${MC}:available`, 100);
    const response = await post(body({ source: { kind: 'mandate', id: `md_${RUN}000003`, period: '2026-10' } }));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('insufficient_funds');
    expect(contract.validateResponse({ method: 'POST', path: '/intents', status: 422, body: response.body })).toEqual([]);
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(100);
    const row = await stack.db.pool.query(`SELECT id, status, failure_code FROM payment_intents WHERE source ->> 'id' = 'md_${RUN}000003'`);
    expect(row.rows[0]).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    expect((await eventsOf(stack, row.rows[0].id)).map((e) => e.type)).toContain('payment_intent.failed');
  });

  it('comercio pagador suspendido: 403 merchant_suspended', async () => {
    await seedMerchant(stack, 'mc_merchant00009', 'suspended');
    const response = await post(body({ payer_merchant_id: 'mc_merchant00009', source: { kind: 'mandate', id: `md_${RUN}000004`, period: '2026-10' } }));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('merchant_suspended');
  });

  it('cuerpo inválido: medio que no es saldo, campo no declarado, periodo mal formado → 422', async () => {
    for (const bad of [body({ payment_method: { type: 'qr' } }), body({ extra: 1 }), body({ source: { kind: 'mandate', id: `md_${RUN}000005`, period: '2026-13' } }), body({ amount_minor: 0 }), body({ kind: 'otro' })]) {
      expect((await post(bad)).status).toBe(422);
    }
  });

  it('GET de un intento que no es de mandato (público) o inexistente es 404', async () => {
    const publicIntent = (await stack.service.createIntent(MC, 'test', key(), { amount_minor: 1000, currency: 'BOB', payment_method: { type: 'qr' } })).body.id as string;
    expect((await request(app.getHttpServer()).get(`/intents/${publicIntent}`).set(SCHEDULES)).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/intents/pi_doesnotexist00').set(SCHEDULES)).status).toBe(404);
  });
});
