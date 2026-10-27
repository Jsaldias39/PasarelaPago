import { verifyApiKey } from '@pay/api-key';
import { createTestContext, type TestContext } from './support/app';
import { activeMerchant, bo, createMerchant, pub, uniqueKey } from './support/http';

/**
 * D-32: cerrar un comercio REVOCA sus claves de API; suspenderlo solo las bloquea (reversible).
 *
 * `api_key.revoked.reason = merchant_closed` ya está en el enum de contracts/asyncapi/merchants-schedules.yaml (PR-16/PR-22): los eventos se
 * validan contra el AsyncAPI vigente SIN sustituciones.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const createKey = (merchantId: string, mode: 'test' | 'live') => pub(ctx, 'post', '/api_keys', merchantId, mode).set('idempotency-key', uniqueKey()).send({ mode });
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;
const keyRow = async (keyId: string) => (await rows('SELECT * FROM api_keys WHERE key_id = $1', [keyId]))[0];

/** Eventos `api_key.revoked` del comercio, en orden de emisión, con el sobre validado contra el AsyncAPI vigente, sin sustituciones. */
async function revokedEvents(merchantId: string) {
  const { rows: found } = await ctx.db.pool.query(`SELECT seq, subject, envelope FROM outbox_events WHERE type = 'api_key.revoked' AND envelope->'data'->>'merchant_id' = $1 ORDER BY seq`, [merchantId]);
  return found.map((r) => {
    const envelope = r.envelope as { data: { reason: string } };
    expect({ subject: r.subject, errors: ctx.events.validate(r.subject as string, envelope) }).toEqual({ subject: r.subject, errors: [] });
    return { seq: Number(r.seq), ...(envelope as { data: Record<string, unknown> }) };
  });
}

describe('cerrar un comercio revoca sus claves (D-32)', () => {
  it('todas las claves vivas (test, live y la que está en gracia de rotación) quedan revocadas con motivo `merchant_closed`, en la misma transacción que `merchant.closed`', async () => {
    const id = await activeMerchant(ctx, 700);
    const t1 = (await createKey(id, 'test')).body;
    const live = (await createKey(id, 'live')).body;
    const rotated = (await pub(ctx, 'post', `/api_keys/${t1.id}/rotate`, id, 'test').set('idempotency-key', uniqueKey())).body; // t1 queda en gracia
    expect((await keyRow(t1.id)).grace_ends_at).not.toBeNull();

    expect((await bo(ctx, 'post', `/merchants/${id}/close`)).status).toBe(200);

    for (const key of [t1.id, live.id, rotated.id]) {
      const row = await keyRow(key);
      expect({ key, revoked: row.revoked_at !== null, reason: row.revoke_reason }).toEqual({ key, revoked: true, reason: 'merchant_closed' });
    }
    const events = await revokedEvents(id);
    expect(events.map((e) => e.data.key_id).sort()).toEqual([t1.id, live.id, rotated.id].sort());
    for (const e of events) expect(e.data).toMatchObject({ merchant_id: id, reason: 'merchant_closed' });
    expect(events.find((e) => e.data.key_id === live.id)?.data.mode).toBe('live');
    // El evento de cierre sale DESPUÉS de las revocaciones y todo comparte la hora del cierre.
    const closed = (await rows(`SELECT seq, envelope FROM outbox_events WHERE type = 'merchant.closed' AND aggregate_id = $1`, [id]))[0];
    expect(Math.max(...events.map((e) => e.seq))).toBeLessThan(Number(closed.seq));
    expect(new Set(events.map((e) => e.data.revoked_at))).toEqual(new Set([closed.envelope.data.closed_at]));
    // Y para el comercio no queda nada vivo.
    const listed = (await pub(ctx, 'get', '/api_keys', id, 'test')).body.data;
    expect(listed.every((k: { revoked_at: string | null }) => k.revoked_at !== null)).toBe(true);
  });

  it('cerrar de nuevo es 409 y no vuelve a revocar ni a anunciar nada', async () => {
    const id = await activeMerchant(ctx, 701);
    await createKey(id, 'test');
    await bo(ctx, 'post', `/merchants/${id}/close`);
    const before = (await revokedEvents(id)).length;
    expect((await bo(ctx, 'post', `/merchants/${id}/close`)).status).toBe(409);
    expect((await revokedEvents(id)).length).toBe(before);
  });

  it('una clave YA revocada no resucita ni cambia: conserva su motivo y su hora, y no se anuncia otra vez', async () => {
    const id = await activeMerchant(ctx, 702);
    const first = (await createKey(id, 'test')).body;
    const second = (await createKey(id, 'test')).body;
    expect((await pub(ctx, 'delete', `/api_keys/${first.id}`, id, 'test')).status).toBe(204);
    const before = await keyRow(first.id);
    expect(before.revoke_reason).toBe('revoked_by_merchant');

    await bo(ctx, 'post', `/merchants/${id}/close`);

    const after = await keyRow(first.id);
    expect({ at: after.revoked_at, reason: after.revoke_reason }).toEqual({ at: before.revoked_at, reason: 'revoked_by_merchant' });
    expect((await keyRow(second.id)).revoke_reason).toBe('merchant_closed');
    const events = await revokedEvents(id);
    expect(events.filter((e) => e.data.key_id === first.id)).toHaveLength(1); // solo la revocación original
    expect(events.filter((e) => e.data.key_id === first.id)[0].data.reason).toBe('revoked_by_merchant');
    expect(events.filter((e) => e.data.key_id === second.id)).toHaveLength(1);
    // Cerrado es terminal: no se puede reactivar y por tanto nada vuelve a la vida.
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(409);
    expect((await keyRow(first.id)).revoked_at).not.toBeNull();
    expect((await keyRow(second.id)).revoked_at).not.toBeNull();
  });

  it('después de cerrar no se crea, rota ni reactiva ninguna clave (403), y nunca queda una clave viva aunque se creen claves a la vez que se cierra', async () => {
    const id = await activeMerchant(ctx, 703);
    const key = (await createKey(id, 'test')).body;
    const racing = await Promise.all([
      bo(ctx, 'post', `/merchants/${id}/close`),
      ...Array.from({ length: 4 }, () => createKey(id, 'test')),
    ]);
    expect(racing[0].status).toBe(200);
    expect((await rows('SELECT 1 FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL', [id]))).toHaveLength(0);
    expect((await createKey(id, 'test')).status).toBe(403);
    expect((await pub(ctx, 'post', `/api_keys/${key.id}/rotate`, id, 'test').set('idempotency-key', uniqueKey())).status).toBe(409);
    // Cada clave revocada tiene exactamente un anuncio.
    const events = await revokedEvents(id);
    const ids = events.map((e) => e.data.key_id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await rows('SELECT count(*)::int AS n FROM api_keys WHERE merchant_id = $1', [id]))[0].n).toBe(ids.length);
  });

  it('un comercio sin claves se cierra igual (sin eventos de claves)', async () => {
    const id = await createMerchant(ctx, 704);
    expect((await bo(ctx, 'post', `/merchants/${id}/close`)).status).toBe(200);
    expect(await revokedEvents(id)).toHaveLength(0);
  });
});

describe('suspender solo bloquea: las claves siguen vivas y reactivar las restaura (D-32)', () => {
  it('suspender NO revoca ninguna clave ni emite api_key.revoked; reactivar deja las mismas claves operativas, con el mismo secreto verificable', async () => {
    const id = await activeMerchant(ctx, 710);
    const test = (await createKey(id, 'test')).body;
    const live = (await createKey(id, 'live')).body;
    const hashes = Object.fromEntries((await rows('SELECT key_id, key_hash, mode FROM api_keys WHERE merchant_id = $1', [id])).map((r) => [r.key_id, r]));

    expect((await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'risk_review' })).status).toBe(200);
    for (const key of [test.id, live.id]) {
      const row = await keyRow(key);
      expect({ key, revoked_at: row.revoked_at, reason: row.revoke_reason }).toEqual({ key, revoked_at: null, reason: null });
    }
    expect(await revokedEvents(id)).toHaveLength(0);
    // Suspendido no crea ni rota (bloqueo), pero tampoco destruye nada.
    const blocked = await createKey(id, 'test');
    expect([blocked.status, blocked.body.code]).toEqual([403, 'merchant_suspended']);

    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
    for (const [key, secret] of [[test.id, test.secret], [live.id, live.secret]] as const) {
      const row = await keyRow(key);
      expect(row.revoked_at).toBeNull();
      expect(verifyApiKey(secret, { keyId: key, mode: hashes[key].mode, keyHash: row.key_hash })).toBe(true);
      expect(row.key_hash).toBe(hashes[key].key_hash);
    }
    const created = await createKey(id, 'test');
    expect(created.status).toBe(201); // reactivado, vuelve a poder crear
    expect(await revokedEvents(id)).toHaveLength(0);
  });

  it('suspender, reactivar y suspender otra vez nunca revoca; solo el cierre lo hace', async () => {
    const id = await activeMerchant(ctx, 711);
    const key = (await createKey(id, 'test')).body;
    for (let i = 0; i < 2; i += 1) {
      await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' });
      await bo(ctx, 'post', `/merchants/${id}/activate`);
    }
    await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' });
    expect((await keyRow(key.id)).revoked_at).toBeNull();
    expect((await bo(ctx, 'post', `/merchants/${id}/close`)).status).toBe(200); // cerrar desde suspendido sí revoca
    expect((await keyRow(key.id)).revoke_reason).toBe('merchant_closed');
  });
});
