import { createTestContext, type TestContext } from './support/app';
import request from 'supertest';
import { acceptContract, approveKyc, bo, createMerchant, currentVersion, ensureContractVersion, eventsOf, readyMerchant, uniqueKey, uploadAllDocs, verified } from './support/http';
import { merchantInput } from './support/fixtures';

/**
 * D-33: la razón social (`legal_name`) viaja SOLO en `merchant.created` y `merchant.activated`, en la misma transacción que el cambio de estado, y
 * esos eventos validan contra el AsyncAPI vigente SIN sustituciones. En ningún otro evento, ni en logs ni en errores.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const LEGAL = 'RAZON-SOCIAL-SINTETICA-D33';
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;
/** Lleva un comercio recién creado hasta «listo para activar» (documentos, KYC aprobado, contrato aceptado). */
const prepare = async (id: string): Promise<void> => {
  await uploadAllDocs(ctx, id);
  await approveKyc(ctx, id);
  await ensureContractVersion(ctx, 1);
  await acceptContract(ctx, id, await currentVersion(ctx));
};
const create = (legal_name: string, n: number) => bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...merchantInput(n), legal_name });

describe('legal_name en merchant.created y merchant.activated (D-33)', () => {
  it('correcto: el alta publica merchant.created con la razón social, válido contra el AsyncAPI sin sustituciones', async () => {
    const res = await create(LEGAL, 800);
    expect(res.status).toBe(201);
    const [event] = await eventsOf(ctx, 'merchant.created', res.body.id); // eventsOf valida el sobre COMPLETO contra el canal
    expect(event.data).toEqual({ merchant_id: res.body.id, status: 'pending', created_at: expect.any(String), legal_name: LEGAL });
  });

  it('correcto: la activación publica merchant.activated con la razón social; reactivar tras suspender la vuelve a publicar', async () => {
    const res = await create(LEGAL, 801);
    const id = res.body.id as string;
    await prepare(id);
    verified(ctx.backofficeContract, 'post', `/merchants/${id}/activate`, await bo(ctx, 'post', `/merchants/${id}/activate`), 200);
    const [first] = await eventsOf(ctx, 'merchant.activated', id);
    expect(first.data).toMatchObject({ merchant_id: id, status: 'active', legal_name: LEGAL });
    await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' });
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
    const events = await eventsOf(ctx, 'merchant.activated', id);
    expect(events).toHaveLength(2);
    expect(events[1].data.legal_name).toBe(events[0].data.legal_name);
  });

  it('la razón social del evento es la del alta (no el nombre de fantasía ni otro dato)', async () => {
    const res = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...merchantInput(802), legal_name: 'Razón Social Ñandú S.R.L.', display_name: 'Fantasía 802' });
    const [event] = await eventsOf(ctx, 'merchant.created', res.body.id);
    expect(event.data.legal_name).toBe('Razón Social Ñandú S.R.L.');
    expect(JSON.stringify(event)).not.toContain('Fantasía 802');
    expect(JSON.stringify(event)).not.toContain(merchantInput(802).tax_id);
  });

  it('límite: 1 y 300 caracteres se publican; 301 se rechaza (422) y NO deja ni comercio ni evento', async () => {
    for (const [name, n] of [['A', 803], ['B'.repeat(300), 804]] as const) {
      const res = await create(name, n);
      expect(res.status).toBe(201);
      expect((await eventsOf(ctx, 'merchant.created', res.body.id))[0].data.legal_name).toBe(name);
    }
    const before = (await rows('SELECT count(*)::int AS n FROM outbox_events'))[0].n;
    const tooLong = await create('C'.repeat(301), 805);
    expect(tooLong.status).toBe(422);
    expect((await rows('SELECT count(*)::int AS n FROM outbox_events'))[0].n).toBe(before);
    expect((await rows('SELECT 1 FROM merchants WHERE tax_id = $1', [merchantInput(805).tax_id]))).toHaveLength(0);
  });

  it('misma transacción: si el alta falla (NIT repetido) o la activación se rechaza (409), NO se publica ningún evento nuevo', async () => {
    const id = await createMerchant(ctx, 806);
    const created = (await rows(`SELECT 1 FROM outbox_events WHERE type = 'merchant.created' AND aggregate_id = $1`, [id])).length;
    expect(created).toBe(1);
    const dup = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...merchantInput(806), legal_name: 'OTRA-RAZON' });
    expect(dup.status).toBe(422);
    expect((await rows(`SELECT 1 FROM outbox_events WHERE type = 'merchant.created' AND envelope->'data'->>'legal_name' = 'OTRA-RAZON'`))).toHaveLength(0);
    // Activar sin KYC ni contrato ⇒ 409 y sin evento de activación.
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(409);
    expect((await rows(`SELECT 1 FROM outbox_events WHERE type = 'merchant.activated' AND aggregate_id = $1`, [id]))).toHaveLength(0);
    // Y cuando sí se activa, el estado y el evento aparecen juntos.
    const ready = await readyMerchant(ctx, 807);
    verified(ctx.backofficeContract, 'post', `/merchants/${ready}/activate`, await bo(ctx, 'post', `/merchants/${ready}/activate`), 200);
    expect((await rows('SELECT status FROM merchants WHERE id = $1', [ready]))[0].status).toBe('active');
    expect(await eventsOf(ctx, 'merchant.activated', ready)).toHaveLength(1);
  });

  it('NO se emite en ningún otro evento, ni se registra en logs, errores ni trazas: recorrido completo del ciclo de vida', async () => {
    const legal = 'CENTINELA-LEGAL-D33-NO-FILTRAR';
    const res = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...merchantInput(808), legal_name: legal });
    const id = res.body.id as string;
    // Lleva el comercio por todo el ciclo: KYC, contrato, activar, tarifa, claves, suspender, reactivar, cerrar.
    await prepare(id);
    await bo(ctx, 'post', `/merchants/${id}/activate`);
    await bo(ctx, 'post', `/merchants/${id}/fee_schedules`, 'op-pricing').send({ channels: [{ channel: 'qr', percent: '3' }] });
    const key = (await request(ctx.server).post('/api_keys').set('x-service-id', 'pay-edge').set('x-merchant-id', id).set('x-pay-mode', 'test').set('idempotency-key', uniqueKey()).send({ mode: 'test' })).body;
    expect(key.id).toBeDefined();
    await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' });
    await bo(ctx, 'post', `/merchants/${id}/activate`);
    await bo(ctx, 'post', `/merchants/${id}/close`);
    // Respuestas de error sobre ese comercio.
    const errors = JSON.stringify([(await bo(ctx, 'post', `/merchants/${id}/activate`)).body, (await bo(ctx, 'get', '/merchants/mc_noexiste0000000000')).body]);

    const typed = (await rows(`SELECT type, envelope::text AS e FROM outbox_events WHERE envelope->>'merchantid' = $1 OR aggregate_id = $1 OR envelope->'data'->>'merchant_id' = $1`, [id])) as { type: string; e: string }[];
    const typesWithName = typed.filter((r) => r.e.includes(legal)).map((r) => r.type);
    expect(typesWithName.sort()).toEqual(['merchant.activated', 'merchant.activated', 'merchant.created']);
    for (const r of typed.filter((r) => !['merchant.created', 'merchant.activated'].includes(r.type))) {
      expect({ type: r.type, hasField: 'legal_name' in JSON.parse(r.e).data, leaks: r.e.includes(legal) }).toEqual({ type: r.type, hasField: false, leaks: false });
    }
    expect(typed.map((r) => r.type)).toEqual(expect.arrayContaining(['fee_schedule.published', 'api_key.created', 'merchant.suspended', 'merchant.closed']));
    expect(ctx.logs.join('\n')).not.toContain(legal);
    expect(errors).not.toContain(legal);
  });
});
