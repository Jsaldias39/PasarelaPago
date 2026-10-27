import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { loadContract, type ContractValidator } from '@pay/testing';
import { InternalPaymentsController } from '../src/payments/internal.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { CONTRACTS } from './doubles/contracts';
import { asMerchant, EDGE, httpApp, normalizeOps, routesOf } from './helpers/http';
import { key, MC, MC2, seedMerchant, startStack, type Stack } from './helpers/stack';

let stack: Stack;
let app: INestApplication;
let publicContract: ContractValidator;
let internalContract: ContractValidator;

const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const post = (merchant: string, body: unknown, idempotencyKey = key()) => request(app.getHttpServer()).post('/payment_intents').set(asMerchant(merchant)).set('idempotency-key', idempotencyKey).send(body as object);

beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  publicContract = await loadContract(CONTRACTS.publicV1);
  internalContract = await loadContract(CONTRACTS.payments);
  await seedMerchant(stack, MC);
  await seedMerchant(stack, MC2);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});

const count = async (table: string, where = 'true'): Promise<number> => Number((await stack.db.pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0]?.n);

describe('P3.H1.M4 · POST /payment_intents (REQ-P3-1)', () => {
  it('crea el cobro, responde 201 conforme al contrato y deja el QR del conector', async () => {
    const response = await post(MC, QR);
    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('false');
    expect(response.body).toMatchObject({ object: 'payment_intent', status: 'requires_action', amount_minor: 10000, fee_minor: 300, net_minor: 9700, next_action: { type: 'display_qr' } });
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: response.body })).toEqual([]);
  });

  it('la misma Idempotency-Key 3 veces devuelve el MISMO cobro, marca el replay y no crea un segundo cargo ni un segundo evento', async () => {
    const k = key();
    const first = await post(MC, QR, k);
    const again = await Promise.all([post(MC, QR, k), post(MC, QR, k)]);
    for (const r of again) {
      expect(r.status).toBe(201);
      expect(r.headers['idempotency-replayed']).toBe('true');
      expect(r.body).toEqual(first.body);
    }
    const id = first.body.id as string;
    expect(await count('payment_intents', `id = '${id}'`)).toBe(1);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(await count('outbox_events', `type = 'payment_intent.created' AND aggregate_id = '${id}'`)).toBe(1);
  });

  it('50 POST concurrentes con la misma clave crean UN solo cobro', async () => {
    const k = key();
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(MC, QR, k)));
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([201]));
    const ids = new Set(responses.map((r) => r.body.id as string));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(await count('payment_intents', `id = '${id}'`)).toBe(1);
    expect(stack.connectors.chargeCreations.get(id as string)).toBe(1);
    expect(responses.filter((r) => r.headers['idempotency-replayed'] === 'false')).toHaveLength(1);
  });

  it('la misma clave con OTRO cuerpo es 422 idempotency_key_reused', async () => {
    const k = key();
    await post(MC, QR, k);
    const reused = await post(MC, { ...QR, amount_minor: 10001 }, k);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('idempotency_key_reused');
  });

  it('sin Idempotency-Key (o demasiado corta) es 400 idempotency_key_required', async () => {
    const missing = await request(app.getHttpServer()).post('/payment_intents').set(asMerchant(MC)).send(QR);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('idempotency_key_required');
    expect((await post(MC, QR, 'corta')).status).toBe(400);
  });

  it('la misma clave en OTRO comercio es otro cobro (el alcance de la clave es el comercio)', async () => {
    const k = key();
    const a = await post(MC, QR, k);
    const b = await post(MC2, QR, k);
    expect(a.body.id).not.toBe(b.body.id);
  });

  describe('validación en el servidor (lista blanca, regla 96.2)', () => {
    const rejected = async (body: unknown, field: string, code: string) => {
      const response = await post(MC, body);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('validation_failed');
      expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field, code })]));
      expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 422, body: response.body })).toEqual([]);
      return response;
    };

    it('importe 0, negativo, decimal o enorme', async () => {
      for (const amount of [0, -5, 10.5, 2 ** 60, '100', null]) await rejected({ ...QR, amount_minor: amount }, 'amount_minor', 'invalid_amount');
    });
    it('moneda distinta de BOB', async () => rejected({ ...QR, currency: 'USD' }, 'currency', 'unsupported_currency'));
    it('campo no declarado (mass assignment)', async () => {
      await rejected({ ...QR, fee_minor: 0 }, 'fee_minor', 'unknown_field');
      await rejected({ ...QR, payment_method: { type: 'qr', merchant_id: MC2 } }, 'payment_method.merchant_id', 'unknown_field');
    });
    it('medio de pago desconocido o tarjeta sin token', async () => {
      await rejected({ ...QR, payment_method: { type: 'cheque' } }, 'payment_method.type', 'invalid_value');
      await rejected({ ...QR, payment_method: { type: 'card' } }, 'payment_method.card_token', 'required');
    });
    it('un número de tarjeta en la descripción o en metadata se rechaza SIN repetirlo', async () => {
      const pan = '4111 1111 1111 1111';
      const description = await rejected({ ...QR, description: `pago de ${pan}` }, 'description', 'contains_card_number');
      expect(JSON.stringify(description.body)).not.toMatch(/4111/);
      const meta = await rejected({ ...QR, metadata: { nota: '4111-1111-1111-1111' } }, 'metadata.nota', 'contains_card_number');
      expect(JSON.stringify(meta.body)).not.toMatch(/4111/);
    });
    it('un número de tarjeta en card_token se rechaza: solo vale la forma tok_…', async () => {
      const response = await rejected({ ...QR, payment_method: { type: 'card', card_token: '4111111111111111' } }, 'payment_method.card_token', 'invalid_token');
      expect(JSON.stringify(response.body)).not.toMatch(/4111/);
    });
    it('vencimiento fuera de rango y metadata inválida', async () => {
      await rejected({ ...QR, expires_in_seconds: 10 }, 'expires_in_seconds', 'out_of_range');
      await rejected({ ...QR, metadata: { 'Clave Mala': 'x' } }, 'metadata.Clave Mala', 'invalid_key');
    });
    it('un cuerpo que no es un objeto', async () => {
      const response = await post(MC, [1, 2, 3]);
      expect(response.status).toBe(422);
    });
    it('un número de tarjeta que falla Luhn NO se confunde con un PAN (un teléfono o un id largo no se bloquea)', async () => {
      const ok = await post(MC, { ...QR, description: 'orden 1234567890123' });
      expect(ok.status).toBe(201);
    });
  });

  it('comisión por medio de pago: la tarifa del comercio se aplica al cotizar', async () => {
    const card = await post(MC, { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'card', card_token: 'tok_abcdefghij12' } });
    expect(card.body).toMatchObject({ fee_minor: 300, net_minor: 9700 }); // 3 %
    const bank = await post(MC, { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'bank_transfer' } });
    expect(bank.status).toBe(422); // sin cuenta recaudadora configurada no se inventan datos bancarios
    expect(bank.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'payment_method_unavailable' })]));
  });
});

describe('P3.H1.M5 · estado del comercio y tarifa (REQ-P3-8)', () => {
  const OTHER = 'mc_merchant00003';

  it('un comercio suspendido recibe 403 merchant_suspended y no se crea nada', async () => {
    await seedMerchant(stack, OTHER, 'suspended');
    const before = await count('payment_intents', `merchant_id = '${OTHER}'`);
    const response = await post(OTHER, QR);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('merchant_suspended');
    expect(await count('payment_intents', `merchant_id = '${OTHER}'`)).toBe(before);
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 403, body: response.body })).toEqual([]);
  });

  it('un comercio desconocido o no activo también se niega (ante la duda, no se cobra)', async () => {
    const unknown = await post('mc_merchant99999', QR);
    expect(unknown.status).toBe(403);
    expect(unknown.body.code).toBe('forbidden');
    await seedMerchant(stack, 'mc_merchant00004', 'pending');
    expect((await post('mc_merchant00004', QR)).status).toBe(403);
  });

  it('sin tarifa publicada: 422 fee_schedule_missing, no se inventa una comisión', async () => {
    await stack.db.pool.query("INSERT INTO merchant_replica (merchant_id, status, occurred_at) VALUES ('mc_merchant00005', 'active', now())");
    const response = await post('mc_merchant00005', QR);
    expect(response.status).toBe(422);
    expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'fee_schedule_missing' })]));
  });

  it('una tarifa nueva (versión 2) rige para los cobros siguientes y una futura no se usa todavía', async () => {
    const id = 'mc_merchant00006';
    await seedMerchant(stack, id);
    const { replicasRepo } = await import('../src/persistence/replicas.repo');
    await replicasRepo.upsertFeeSchedule(stack.db.pool, { merchantId: id, version: 2, currency: 'BOB', channels: [{ channel: 'qr', percent: '1' }], effectiveFrom: new Date(Date.now() - 1000), effectiveTo: null });
    await replicasRepo.upsertFeeSchedule(stack.db.pool, { merchantId: id, version: 3, currency: 'BOB', channels: [{ channel: 'qr', percent: '9' }], effectiveFrom: new Date(Date.now() + 86_400_000), effectiveTo: null });
    const response = await post(id, QR);
    expect(response.body).toMatchObject({ fee_minor: 100, net_minor: 9900 });
  });
});

describe('P3.H1.M6 · un comercio no ve lo del otro (BOLA)', () => {
  it('GET, cancelar y reembolsar un cobro AJENO responden 404 idéntico a uno inexistente', async () => {
    const mine = (await post(MC, QR)).body.id as string;
    const ghost = 'pi_doesnotexist00';
    for (const [method, path, body] of [['get', `/payment_intents/${mine}`], ['post', `/payment_intents/${mine}/cancel`], ['post', `/payment_intents/${mine}/refunds`, { amount_minor: 1 }]] as const) {
      const ghostPath = path.replace(mine, ghost);
      const agent = (p: string) => (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[method](p).set(asMerchant(MC2)).set('idempotency-key', key());
      const foreign = await agent(path).send((body ?? {}) as object);
      const missing = await agent(ghostPath).send((body ?? {}) as object);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('resource_not_found');
      expect({ ...foreign.body, instance: undefined, request_id: undefined }).toEqual({ ...missing.body, instance: undefined, request_id: undefined });
    }
    // …y el cobro propio sigue intacto.
    expect((await request(app.getHttpServer()).get(`/payment_intents/${mine}`).set(asMerchant(MC))).body.status).toBe('requires_action');
  });

  it('el listado solo trae los cobros del comercio', async () => {
    const response = await request(app.getHttpServer()).get('/payment_intents?limit=100').set(asMerchant(MC2));
    expect(response.status).toBe(200);
    for (const intent of response.body.data) {
      const row = await stack.db.pool.query('SELECT merchant_id FROM payment_intents WHERE id = $1', [intent.id]);
      expect(row.rows[0]?.merchant_id).toBe(MC2);
    }
  });

  it('un id con forma inválida es 404 sin tocar la base', async () => {
    for (const bad of ['x', 'pi_', '..%2f..', 'PI_ABCDEFGHIJ12']) {
      const response = await request(app.getHttpServer()).get(`/payment_intents/${bad}`).set(asMerchant(MC));
      expect(response.status).toBe(404);
    }
  });
});

describe('listado paginado (regla 96.6)', () => {
  it('páginas de a 2, de más nuevo a más viejo, sin repetir ni perder ninguno', async () => {
    const merchant = 'mc_merchant00007';
    await seedMerchant(stack, merchant);
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push((await post(merchant, { ...QR, amount_minor: 1000 + i })).body.id as string);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await request(app.getHttpServer()).get('/payment_intents').query({ limit: 2, ...(cursor ? { starting_after: cursor } : {}) }).set(asMerchant(merchant));
      expect(response.status).toBe(200);
      expect(publicContract.validateResponse({ method: 'GET', path: '/payment_intents', status: 200, body: response.body })).toEqual([]);
      seen.push(...response.body.data.map((i: { id: string }) => i.id));
      if (!response.body.has_more) break;
      cursor = response.body.next_cursor as string;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...created].reverse());
  });

  it('filtro por estado y límites inválidos', async () => {
    expect((await request(app.getHttpServer()).get('/payment_intents?limit=0').set(asMerchant(MC))).status).toBe(422);
    expect((await request(app.getHttpServer()).get('/payment_intents?limit=101').set(asMerchant(MC))).status).toBe(422);
    expect((await request(app.getHttpServer()).get('/payment_intents?status=raro').set(asMerchant(MC))).status).toBe(422);
    expect((await request(app.getHttpServer()).get('/payment_intents?starting_after=basura').set(asMerchant(MC))).status).toBe(422);
    const onlyWaiting = await request(app.getHttpServer()).get('/payment_intents?status=requires_action&limit=100').set(asMerchant(MC));
    expect(onlyWaiting.body.data.every((i: { status: string }) => i.status === 'requires_action')).toBe(true);
  });
});

describe('identidad de servicio: matriz negativa por ruta (regla 80.2.3)', () => {
  const publicRoutes: [string, string][] = [['post', '/payment_intents'], ['get', '/payment_intents'], ['get', '/payment_intents/pi_aaaaaaaaaa'], ['post', '/payment_intents/pi_aaaaaaaaaa/cancel'], ['post', '/payment_intents/pi_aaaaaaaaaa/refunds']];
  const internalRoutes: [string, string][] = [['post', '/intents'], ['get', '/intents/pi_aaaaaaaaaa']];
  const call = (method: string, path: string, headers: Record<string, string>) => (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[method](path).set(headers).set('idempotency-key', key()).send({});

  it.each(publicRoutes)('%s %s: sin X-Service-Id, o de otro servicio, es 403', async (method, path) => {
    expect((await call(method, path, { 'x-merchant-id': MC })).status).toBe(403);
    for (const service of ['pay-risk', 'pay-schedules', 'pay-ledger', 'pay-connectors']) expect((await call(method, path, { 'x-service-id': service, 'x-merchant-id': MC })).status).toBe(403);
    expect((await call(method, path, { 'x-service-id': 'no es un servicio', 'x-merchant-id': MC })).status).toBe(403);
  });

  it.each(internalRoutes)('%s %s: solo pay-schedules; pay-edge (el borde público) es 403', async (method, path) => {
    expect((await call(method, path, {})).status).toBe(403);
    expect((await call(method, path, { ...EDGE })).status).toBe(403);
    expect((await call(method, path, { 'x-service-id': 'pay-risk' })).status).toBe(403);
  });

  it('la ruta pública sin X-Merchant-Id (o con uno mal formado) es 401', async () => {
    const response = await request(app.getHttpServer()).get('/payment_intents').set(EDGE);
    expect(response.status).toBe(401);
    expect((await request(app.getHttpServer()).get('/payment_intents').set({ ...EDGE, 'x-merchant-id': 'cualquiera' })).status).toBe(401);
  });
});

describe('contrato: el servicio implementa TODO lo que le toca', () => {
  it('cada operación de payment_intents de public-v1.yaml tiene su ruta (y no sobra ninguna)', () => {
    const ops = normalizeOps(publicContract.operations().filter((op) => op.includes(' /payment_intents')));
    expect(routesOf(PaymentsController as never)).toEqual(ops);
  });

  it('cada operación de internal-payments-v1.yaml tiene su ruta (y no sobra ninguna)', () => {
    expect(routesOf(InternalPaymentsController as never, 'intents')).toEqual(normalizeOps(internalContract.operations()));
  });
});
