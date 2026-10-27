import { createTestContext, type TestContext } from './support/app';
import { acceptContract, bo, createMerchant, ensureContractVersion, uniqueKey, verified } from './support/http';
import { SHA } from './support/fixtures';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const publish = (body: object, as = 'op-legal') => bo(ctx, 'post', '/contract_versions', as).send(body);

describe('contrato legal versionado (REQ-P5-2, P5.H1.M4)', () => {
  it('las versiones solo se agregan en orden: la 1, luego la 2; saltarse una, repetirla o ir hacia atrás en el tiempo se rechaza', async () => {
    expect(verified(ctx.backofficeContract, 'post', '/contract_versions', await publish({ version: 1, text_sha256: SHA }), 201)).toMatchObject({ version: 1, text_sha256: SHA });
    expect((await publish({ version: 3, text_sha256: SHA })).body.errors).toEqual([{ field: 'version', code: 'not_next' }]);
    expect((await publish({ version: 1, text_sha256: SHA })).status).toBe(422);
    expect((await publish({ version: 2, text_sha256: 'b'.repeat(64), effective_from: '2000-01-01T00:00:00Z' })).body.errors).toEqual([{ field: 'effective_from', code: 'before_previous_version' }]);
    expect((await publish({ version: 2, text_sha256: 'no-es-un-hash' })).status).toBe(422);
    expect((await publish({ version: 2, text_sha256: 'b'.repeat(64) })).status).toBe(201);
  });

  it('registra la aceptación con versión, hash del texto, quién la declaró, quién la registró y cuándo', async () => {
    const id = await createMerchant(ctx, 200);
    const res = await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`, 'op-merchant').send({ version: 2, accepted_by_ref: 'representante-sintetico-200' });
    const body = verified(ctx.backofficeContract, 'post', `/merchants/${id}/contract_acceptances`, res, 201);
    expect(body).toMatchObject({ merchant_id: id, version: 2, text_sha256: 'b'.repeat(64), accepted_by_ref: 'representante-sintetico-200', recorded_by: 'operator_merchant_01' });
    expect(new Date(body.accepted_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('`recorded_by` sale de la credencial: mandarlo en el cuerpo se rechaza', async () => {
    const id = await createMerchant(ctx, 201);
    const res = await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 2, accepted_by_ref: 'x', recorded_by: 'otro' });
    expect(res.status).toBe(422);
  });

  it('la aceptación es INMUTABLE a nivel de base: UPDATE, DELETE y TRUNCATE fallan aunque se llegue con SQL directo', async () => {
    const id = await createMerchant(ctx, 202);
    await acceptContract(ctx, id, 2);
    await expect(ctx.db.pool.query(`UPDATE contract_acceptances SET accepted_by_ref = 'falsificado' WHERE merchant_id = $1`, [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM contract_acceptances WHERE merchant_id = $1', [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('TRUNCATE contract_acceptances')).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query(`UPDATE contract_versions SET text_sha256 = '${'c'.repeat(64)}' WHERE version = 2`)).rejects.toThrow(/inmutable/);
    expect(Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM contract_acceptances WHERE merchant_id = $1', [id])).rows[0].n)).toBe(1);
  });

  it('aceptar dos veces la misma versión es 409; una versión inexistente es 422; un cuerpo con campos de más es 422', async () => {
    const id = await createMerchant(ctx, 203);
    await acceptContract(ctx, id, 1);
    const again = await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 1, accepted_by_ref: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.errors).toEqual([{ field: 'version', code: 'already_accepted' }]);
    expect((await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 99, accepted_by_ref: 'x' })).body.errors).toEqual([{ field: 'version', code: 'unknown' }]);
    expect((await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 2 })).status).toBe(422);
  });

  it('una versión con vigencia futura no se puede aceptar todavía', async () => {
    await ensureContractVersion(ctx, 2);
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await publish({ version: 3, text_sha256: 'd'.repeat(64), effective_from: future })).status).toBe(201);
    const id = await createMerchant(ctx, 204);
    const res = await bo(ctx, 'post', `/merchants/${id}/contract_acceptances`).send({ version: 3, accepted_by_ref: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'version', code: 'not_yet_effective' }]);
  });

  it('50 publicaciones simultáneas de la misma versión: una gana, las demás son 422 (sin huecos ni duplicados)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => publish({ version: 4, text_sha256: 'e'.repeat(64), effective_from: new Date(Date.now() + 7200_000).toISOString() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(9);
    void uniqueKey;
  });
});
