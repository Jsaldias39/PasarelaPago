import { createTestContext, type TestContext } from './support/app';
import { bo, createMerchant, ensureContractVersion, eventsOf, pub, readyMerchant, uniqueKey, uploadAllDocs } from './support/http';
import { merchantInput } from './support/fixtures';

/**
 * GATE «Idempotencia» (PLAN-MAESTRO §7): cada mutación repetida N veces EN PARALELO tiene un solo efecto. Este archivo cubre las mutaciones del
 * back-office y de rotación que no tenían su prueba de paralelismo; las demás ya la tienen (activar ×10: merchants-state; claves ×5/×8 y
 * revocar ×5: api-keys; versiones de tarifa ×5: fees; versión de contrato ×10: legal-contract; cierre con claves a la vez: merchant-close-keys).
 * Todas contra Postgres REAL y el outbox real; ninguna con el ORM mockeado.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const N = 10;
const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b);
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

describe('mutaciones repetidas en paralelo ⇒ un solo efecto', () => {
  it('POST /merchants con la MISMA Idempotency-Key ×10: un solo comercio, un solo merchant.created, y todos reciben el mismo id', async () => {
    const key = uniqueKey();
    const input = merchantInput(901);
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(input)));
    const winners = results.filter((r) => r.status === 201);
    expect(winners).toHaveLength(1);
    // Los demás: la respuesta guardada (200) o «en curso» (409); nunca un segundo alta ni un 5xx.
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 200 || r.status === 409)).toBe(true);
    for (const r of results.filter((x) => x.status === 200)) expect(r.body.id).toBe(winners[0]!.body.id);
    expect(await count('SELECT count(*)::int AS n FROM merchants WHERE tax_id = $1', [input.tax_id])).toBe(1);
    expect(await eventsOf(ctx, 'merchant.created', winners[0]!.body.id)).toHaveLength(1);
  });

  it('POST /merchants con claves DISTINTAS y el mismo NIT ×10: gana uno; el resto es 422 y no deja comercio ni evento', async () => {
    const input = merchantInput(902);
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send(input)));
    expect(statuses(results).filter((s) => s === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 422)).toBe(true);
    expect(await count('SELECT count(*)::int AS n FROM merchants WHERE tax_id = $1', [input.tax_id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'merchant.created' AND envelope->'data'->>'merchant_id' IN (SELECT id FROM merchants WHERE tax_id = $1)`, [input.tax_id])).toBe(1);
  });

  it('suspender ×10: una suspensión (200), el resto 409, UN solo merchant.suspended', async () => {
    const id = await readyMerchant(ctx, 903);
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' })));
    expect(statuses(results)).toEqual([200, ...Array<number>(N - 1).fill(409)]);
    expect(await eventsOf(ctx, 'merchant.suspended', id)).toHaveLength(1);
  });

  it('cerrar ×10: un cierre (200), el resto 409, UN solo merchant.closed y una sola revocación por clave', async () => {
    const id = await readyMerchant(ctx, 904);
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
    const key = (await pub(ctx, 'post', '/api_keys', id, 'test').set('idempotency-key', uniqueKey()).send({ mode: 'test' })).body;
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'post', `/merchants/${id}/close`)));
    expect(statuses(results)).toEqual([200, ...Array<number>(N - 1).fill(409)]);
    expect(await eventsOf(ctx, 'merchant.closed', id)).toHaveLength(1);
    expect(await eventsOf(ctx, 'api_key.revoked', key.id)).toHaveLength(1);
  });

  it('aceptar la misma versión del contrato ×10: una aceptación (201), el resto 409, una sola fila', async () => {
    const id = await createMerchant(ctx, 905);
    await ensureContractVersion(ctx, 1);
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 1, accepted_by_ref: 'representante-sintetico-01' })));
    expect(statuses(results)).toEqual([201, ...Array<number>(N - 1).fill(409)]);
    expect(await count('SELECT count(*)::int AS n FROM contract_acceptances WHERE merchant_id = $1', [id])).toBe(1);
  });

  it('revisión KYC ×10 (PUT, mismo estado final): todas 200, una sola fila de KYC en `approved`', async () => {
    const id = await createMerchant(ctx, 906);
    await uploadAllDocs(ctx, id);
    const results = await Promise.all(Array.from({ length: N }, () => bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'approved', risk_level: 'low' })));
    expect(statuses(results)).toEqual(Array<number>(N).fill(200));
    expect((await ctx.db.pool.query('SELECT status FROM merchant_kyc WHERE merchant_id = $1', [id])).rows).toEqual([{ status: 'approved' }]);
  });

  it('subir un documento de KYC ×5 a la vez es un alta APPEND-ONLY (no hay clave de idempotencia): cinco documentos distintos, ninguno pisa a otro', async () => {
    const id = await createMerchant(ctx, 907);
    const upload = () => bo(ctx, 'post', `/merchants/${id}/kyc/documents`, 'op-kyc').field('kind', 'nit').attach('file', Buffer.from(`%PDF-1.7\n% sintético ${Math.random()}\n%%EOF\n`), { filename: 'nit.pdf', contentType: 'application/pdf' });
    const results = await Promise.all(Array.from({ length: 5 }, upload));
    expect(statuses(results)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(5);
    expect(await count(`SELECT count(*)::int AS n FROM kyc_documents WHERE merchant_id = $1 AND kind = 'nit'`, [id])).toBe(5);
  });

  it('rotar la misma clave con la MISMA Idempotency-Key ×5: una clave nueva, un solo api_key.created adicional, las demás respuestas sin secreto', async () => {
    const id = await createMerchant(ctx, 908);
    const old = (await pub(ctx, 'post', '/api_keys', id, 'test').set('idempotency-key', uniqueKey()).send({ mode: 'test' })).body;
    const key = uniqueKey();
    const results = await Promise.all(Array.from({ length: 5 }, () => pub(ctx, 'post', `/api_keys/${old.id}/rotate`, id, 'test').set('idempotency-key', key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 200 || r.status === 409)).toBe(true);
    for (const r of results.filter((x) => x.status === 200)) expect(r.body).not.toHaveProperty('secret');
    expect(await count('SELECT count(*)::int AS n FROM api_keys WHERE merchant_id = $1', [id])).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'api_key.created' AND envelope->'data'->>'merchant_id' = $1`, [id])).toBe(2);
  });

  it('revocar una clave comprometida desde el back-office ×5: todas 204 y UN solo api_key.revoked', async () => {
    const id = await createMerchant(ctx, 909);
    const created = (await pub(ctx, 'post', '/api_keys', id, 'test').set('idempotency-key', uniqueKey()).send({ mode: 'test' })).body;
    const results = await Promise.all(Array.from({ length: 5 }, () => bo(ctx, 'post', `/merchants/${id}/api_keys/${created.id}/revoke`, 'op-security')));
    expect(statuses(results)).toEqual([204, 204, 204, 204, 204]);
    expect(await eventsOf(ctx, 'api_key.revoked', created.id)).toHaveLength(1);
  });
});
