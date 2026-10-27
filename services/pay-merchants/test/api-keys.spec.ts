import request from 'supertest';
import { parseApiKey, verifyApiKey } from '@pay/api-key';
import { ApiKeysService } from '../src/api-keys/api-keys.service';
import { createTestContext, type TestContext } from './support/app';
import { activeMerchant, bo, createMerchant, eventsOf, pub, uniqueKey, verified } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

type Mode = 'test' | 'live';
// `as` es el modo de la clave con la que llama el cliente (lo fija pay-edge en X-Pay-Mode); por defecto, el de la clave que se crea.
const create = (merchantId: string, body: Record<string, unknown> = { mode: 'test' }, key = uniqueKey(), as: Mode = (body.mode === 'live' ? 'live' : 'test')) =>
  pub(ctx, 'post', '/api_keys', merchantId, as).set('idempotency-key', key).send(body);
const rotate = (merchantId: string, keyId: string, key = uniqueKey(), as: Mode = 'test') => pub(ctx, 'post', `/api_keys/${keyId}/rotate`, merchantId, as).set('idempotency-key', key);
const list = (merchantId: string, as: Mode = 'test') => pub(ctx, 'get', '/api_keys', merchantId, as);
const revoke = (merchantId: string, keyId: string, as: Mode = 'test') => pub(ctx, 'delete', `/api_keys/${keyId}`, merchantId, as);
const row = async (keyId: string) => (await ctx.db.pool.query('SELECT * FROM api_keys WHERE key_id = $1', [keyId])).rows[0];
const keys = () => ctx.app.get(ApiKeysService);

describe('claves de API (REQ-P5-4, P5.H1.M6, D-27)', () => {
  it('el secreto se muestra UNA vez, tiene la forma de D-27 y la base guarda solo el hash que lo verifica', async () => {
    const id = await createMerchant(ctx, 400);
    const body = verified(ctx.publicContract, 'post', '/api_keys', await create(id, { mode: 'test', label: 'caja 1' }), 201);
    expect(body).toMatchObject({ object: 'api_key', mode: 'test', label: 'caja 1', revoked_at: null });
    const parsed = parseApiKey(body.secret);
    expect(parsed).not.toBeNull();
    expect(`key_${(body.secret as string).split('_')[2]}`).toBe(body.id);
    expect(body.last4).toBe((body.secret as string).slice(-4));

    const stored = await row(body.id);
    expect(stored.key_hash).toMatch(/^sha256\$[0-9a-f]{64}$/);
    expect(stored.mode).toBe('test');
    expect(verifyApiKey(body.secret, { keyId: stored.key_id, mode: stored.mode, keyHash: stored.key_hash })).toBe(true);
    // El mismo secreto no verifica con otro modo ni con otro id (el hash ata modo|id|secreto).
    expect(verifyApiKey(body.secret, { keyId: stored.key_id, mode: 'live', keyHash: stored.key_hash })).toBe(false);
    expect(verifyApiKey((body.secret as string).replace('sk_test_', 'sk_live_'), { keyId: stored.key_id, mode: 'test', keyHash: stored.key_hash })).toBe(false);
    expect(verifyApiKey(`${body.secret}x`, { keyId: stored.key_id, mode: 'test', keyHash: stored.key_hash })).toBe(false);
  });

  it('el secreto no queda en NINGÚN lado: ni en la tabla de claves, ni en el outbox, ni en la idempotencia, ni en los logs', async () => {
    const id = await createMerchant(ctx, 401);
    const body = verified(ctx.publicContract, 'post', '/api_keys', await create(id), 201);
    const secret = (body.secret as string).split('_')[3];
    const tables = ['api_keys', 'outbox_events', 'idempotency_keys'];
    for (const table of tables) {
      const dump = (await ctx.db.pool.query(`SELECT row_to_json(t)::text AS j FROM ${table} t`)).rows.map((r) => r.j).join('\n');
      expect({ table, leaked: dump.includes(secret) || dump.includes(body.secret) }).toEqual({ table, leaked: false });
    }
    expect(ctx.logs.join('\n')).not.toContain(secret);
    // Y la lectura posterior tampoco lo trae.
    const listed = verified(ctx.publicContract, 'get', '/api_keys', await list(id), 200);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.data[0]).not.toHaveProperty('secret');
  });

  it('publica api_key.created con el hash (D-27), el modo y los últimos 4, válido contra el AsyncAPI y sin el secreto', async () => {
    const id = await createMerchant(ctx, 402);
    const body = (await create(id)).body;
    const [event] = await eventsOf(ctx, 'api_key.created', body.id);
    expect(event.data).toMatchObject({ key_id: body.id, merchant_id: id, mode: 'test', last4: body.last4, key_hash: (await row(body.id)).key_hash });
    expect(JSON.stringify(event)).not.toContain(body.secret);
  });

  it('modos: `test` para comercios pending/active; `live` solo activo; suspendido ⇒ merchant_suspended; cerrado ⇒ forbidden', async () => {
    const pending = await createMerchant(ctx, 403);
    expect((await create(pending, { mode: 'test' })).status).toBe(201);
    expect((await create(pending, { mode: 'live' })).status).toBe(403);

    const active = await activeMerchant(ctx, 404);
    expect((await create(active, { mode: 'live' })).status).toBe(201);
    expect((await create(active, { mode: 'test' })).status).toBe(201);

    expect((await bo(ctx, 'post', `/merchants/${active}/suspend`).send({ reason: 'manual' })).status).toBe(200);
    const suspended = await create(active, { mode: 'test' });
    expect([suspended.status, suspended.body.code]).toEqual([403, 'merchant_suspended']);

    expect((await bo(ctx, 'post', `/merchants/${active}/close`)).status).toBe(200);
    expect((await create(active, { mode: 'test' })).status).toBe(403);
  });

  it('valida el cuerpo: modo inválido, campos de más, etiqueta larga y cuerpo vacío son 422; sin Idempotency-Key es 400', async () => {
    const id = await createMerchant(ctx, 405);
    for (const body of [{ mode: 'prod' }, { mode: 'test', admin: true }, { mode: 'test', label: 'x'.repeat(81) }, {}, { mode: 7 }]) {
      expect({ body, status: (await create(id, body)).status }).toEqual({ body, status: 422 });
    }
    const missing = await pub(ctx, 'post', '/api_keys', id).send({ mode: 'test' });
    expect([missing.status, missing.body.code]).toEqual([400, 'idempotency_key_required']);
    expect((await ctx.db.pool.query('SELECT 1 FROM api_keys WHERE merchant_id = $1', [id])).rows).toHaveLength(0);
  });

  it('idempotencia: repetir la misma petición NO crea otra clave ni devuelve el secreto (200); con otro cuerpo es 422', async () => {
    const id = await createMerchant(ctx, 406);
    const key = uniqueKey();
    const first = await create(id, { mode: 'test' }, key);
    expect(first.status).toBe(201);
    const again = await create(id, { mode: 'test' }, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).not.toHaveProperty('secret');
    expect(again.body.id).toBe(first.body.id);
    const reused = await create(id, { mode: 'test', label: 'otra' }, key);
    expect([reused.status, reused.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect((await ctx.db.pool.query('SELECT 1 FROM api_keys WHERE merchant_id = $1', [id])).rows).toHaveLength(1);
    expect(await eventsOf(ctx, 'api_key.created', first.body.id)).toHaveLength(1);
  });

  it('concurrencia ×5 con la misma Idempotency-Key: una sola clave y un solo evento', async () => {
    const id = await createMerchant(ctx, 407);
    const key = uniqueKey();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(id, { mode: 'test' }, key)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
    expect((await ctx.db.pool.query('SELECT 1 FROM api_keys WHERE merchant_id = $1', [id])).rows).toHaveLength(1);
    expect((await ctx.db.pool.query(`SELECT 1 FROM outbox_events WHERE type = 'api_key.created' AND (envelope->>'merchantid' = $1 OR envelope->'data'->>'merchant_id' = $1)`, [id])).rows).toHaveLength(1);
  });

  it('concurrencia ×5 con claves distintas respeta el tope de claves activas (5 en la prueba)', async () => {
    const id = await createMerchant(ctx, 408);
    const results = await Promise.all(Array.from({ length: 8 }, () => create(id, { mode: 'test' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.errors[0].code === 'too_many_active_keys')).toBe(true);
    expect((await ctx.db.pool.query('SELECT 1 FROM api_keys WHERE merchant_id = $1', [id])).rows).toHaveLength(5);
  });

  describe('separación test / live (D-28)', () => {
    it('una clave test no crea claves live y una live no crea test: 403 forbidden y no se escribe nada', async () => {
      const id = await activeMerchant(ctx, 430);
      const before = async () => Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM api_keys WHERE merchant_id = $1', [id])).rows[0].n);
      const testToLive = await create(id, { mode: 'live' }, uniqueKey(), 'test');
      expect([testToLive.status, testToLive.body.code]).toEqual([403, 'forbidden']);
      const liveToTest = await create(id, { mode: 'test' }, uniqueKey(), 'live');
      expect([liveToTest.status, liveToTest.body.code]).toEqual([403, 'forbidden']);
      expect(await before()).toBe(0);
      expect(await eventsOf(ctx, 'api_key.created')).not.toContainEqual(expect.objectContaining({ subject: expect.stringContaining(id) }));
      // Mismo modo sí.
      expect((await create(id, { mode: 'live' }, uniqueKey(), 'live')).status).toBe(201);
      expect((await create(id, { mode: 'test' }, uniqueKey(), 'test')).status).toBe(201);
    });

    it('una clave de un modo no lista, rota ni revoca claves del otro: 404 (no 403), y nada cambia', async () => {
      const id = await activeMerchant(ctx, 431);
      const live = (await create(id, { mode: 'live' })).body;
      const testKey = (await create(id, { mode: 'test' })).body;
      expect((await list(id, 'test')).body.data.map((k: { id: string }) => k.id)).toEqual([testKey.id]);
      expect((await list(id, 'live')).body.data.map((k: { id: string }) => k.id)).toEqual([live.id]);
      expect((await rotate(id, live.id, uniqueKey(), 'test')).status).toBe(404);
      expect((await revoke(id, live.id, 'test')).status).toBe(404);
      expect((await rotate(id, testKey.id, uniqueKey(), 'live')).status).toBe(404);
      expect((await revoke(id, testKey.id, 'live')).status).toBe(404);
      for (const k of [live, testKey]) {
        const stored = await row(k.id);
        expect({ id: k.id, revoked: stored.revoked_at, grace: stored.grace_ends_at }).toEqual({ id: k.id, revoked: null, grace: null });
      }
      expect(await eventsOf(ctx, 'api_key.revoked', live.id)).toHaveLength(0);
      // El mismo modo sí opera.
      expect((await revoke(id, live.id, 'live')).status).toBe(204);
    });

    it('sin X-Pay-Mode o con un valor inválido, TODAS las rutas públicas responden 403 (seguro por defecto)', async () => {
      const id = await activeMerchant(ctx, 432);
      const mine = (await create(id, { mode: 'test' })).body;
      const calls: [string, string][] = [['get', '/merchants/me'], ['get', '/api_keys'], ['post', '/api_keys'], ['post', `/api_keys/${mine.id}/rotate`], ['delete', `/api_keys/${mine.id}`]];
      for (const mode of [undefined, '', 'sandbox', 'LIVE', 'test,live', 'prod', ' x ']) {
        for (const [method, path] of calls) {
          const req = request(ctx.server)[method as 'get'](path).set('x-service-id', 'pay-edge').set('x-merchant-id', id).set('idempotency-key', uniqueKey());
          if (mode !== undefined) req.set('x-pay-mode', mode);
          const res = method === 'post' && path === '/api_keys' ? await req.send({ mode: 'test' }) : await req;
          expect({ mode, path, method, status: res.status }).toEqual({ mode, path, method, status: 403 });
        }
      }
      expect((await row(mine.id)).revoked_at).toBeNull();
    });

    it('el modo nunca sale del cuerpo: el cuerpo no puede traer otro campo de modo ni sobreescribir el de la cabecera', async () => {
      const id = await activeMerchant(ctx, 433);
      const res = await create(id, { mode: 'live', caller_mode: 'live' }, uniqueKey(), 'test');
      expect(res.status).toBe(422);
      expect((await create(id, { mode: 'live' }, uniqueKey(), 'test')).status).toBe(403);
    });

    it('el back-office de seguridad sí revoca una clave comprometida de cualquier modo', async () => {
      const id = await activeMerchant(ctx, 434);
      const live = (await create(id, { mode: 'live' })).body;
      expect((await bo(ctx, 'post', `/merchants/${id}/api_keys/${live.id}/revoke`, 'op-security')).status).toBe(204);
      expect((await row(live.id)).revoke_reason).toBe('compromised');
    });
  });

  describe('multi-tenant (BOLA)', () => {
    it('otro comercio no ve, no rota ni revoca mis claves: 404 igual que si no existieran', async () => {
      const a = await createMerchant(ctx, 409);
      const b = await createMerchant(ctx, 410);
      const mine = (await create(a)).body;
      expect((await list(b)).body.data).toEqual([]);
      expect((await revoke(b, mine.id)).status).toBe(404);
      expect((await rotate(b, mine.id)).status).toBe(404);
      expect((await row(mine.id)).revoked_at).toBeNull();
      expect((await row(mine.id)).grace_ends_at).toBeNull();
      expect((await revoke(b, 'key_noexisteeeeeeeeeeee')).status).toBe(404);
      expect((await revoke(b, '../../etc/passwd')).status).toBe(404);
    });

    it('sin X-Merchant-Id, o con uno mal formado, es 403 en todas las rutas públicas', async () => {
      for (const header of [undefined, '', 'mc_', "mc_x'; DROP TABLE api_keys;--", 'merchant']) {
        for (const [method, path] of [['get', '/api_keys'], ['get', '/merchants/me'], ['post', '/api_keys'], ['delete', '/api_keys/key_aaaaaaaaaaaa']] as const) {
          const req = pub(ctx, method, path, 'x').set('idempotency-key', uniqueKey());
          if (header === undefined) req.unset('x-merchant-id');
          else req.set('x-merchant-id', header);
          const res = await req.send(method === 'post' ? { mode: 'test' } : undefined);
          expect({ header, path, status: res.status }).toEqual({ header, path, status: 403 });
        }
      }
    });
  });

  describe('revocación', () => {
    it('DELETE revoca (204), es idempotente y publica un solo api_key.revoked con motivo revoked_by_merchant', async () => {
      const id = await createMerchant(ctx, 411);
      const created = (await create(id)).body;
      const first = await revoke(id, created.id);
      expect(first.status).toBe(204);
      ctx.publicContract.assertResponse({ method: 'delete', path: `/api_keys/${created.id}`, status: 204, body: undefined });
      expect((await revoke(id, created.id)).status).toBe(204);
      const events = await eventsOf(ctx, 'api_key.revoked', created.id);
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ key_id: created.id, merchant_id: id, mode: 'test', reason: 'revoked_by_merchant' });
      const listed = (await list(id)).body.data.find((k: { id: string }) => k.id === created.id);
      expect(listed.revoked_at).not.toBeNull();
    });

    it('revocar libera cupo del tope y una clave revocada no se puede rotar (409)', async () => {
      const id = await createMerchant(ctx, 412);
      const made = [];
      for (let i = 0; i < 5; i += 1) made.push((await create(id)).body);
      expect((await create(id)).status).toBe(422);
      await revoke(id, made[0].id);
      expect((await create(id)).status).toBe(201);
      const rotateRevoked = await rotate(id, made[0].id);
      expect(rotateRevoked.status).toBe(409);
    });

    it('back-office: security_operator revoca una clave comprometida (motivo compromised); otros roles 403; ajena 404', async () => {
      const id = await createMerchant(ctx, 413);
      const other = await createMerchant(ctx, 414);
      const created = (await create(id)).body;
      const path = `/merchants/${id}/api_keys/${created.id}/revoke`;
      expect((await bo(ctx, 'post', path, 'op-merchant')).status).toBe(403);
      expect((await bo(ctx, 'post', `/merchants/${other}/api_keys/${created.id}/revoke`, 'op-security')).status).toBe(404);
      expect((await row(created.id)).revoked_at).toBeNull();
      expect((await bo(ctx, 'post', path, 'op-security')).status).toBe(204);
      expect((await row(created.id)).revoke_reason).toBe('compromised');
      expect((await eventsOf(ctx, 'api_key.revoked', created.id))[0].data.reason).toBe('compromised');
    });

    it('revocar con concurrencia ×5 produce un solo evento', async () => {
      const id = await createMerchant(ctx, 415);
      const created = (await create(id)).body;
      const results = await Promise.all(Array.from({ length: 5 }, () => revoke(id, created.id)));
      expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204, 204]);
      expect(await eventsOf(ctx, 'api_key.revoked', created.id)).toHaveLength(1);
    });
  });

  describe('rotación con periodo de gracia', () => {
    it('la clave nueva trae su secreto; la anterior sigue válida (sin revocar) y muestra cuándo vence', async () => {
      const id = await createMerchant(ctx, 416);
      const old = (await create(id, { mode: 'test', label: 'principal' })).body;
      const res = await rotate(id, old.id);
      const fresh = verified(ctx.publicContract, 'post', `/api_keys/${old.id}/rotate`, res, 201);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh).toMatchObject({ mode: 'test', label: 'principal' });
      expect(parseApiKey(fresh.secret)).not.toBeNull();
      const oldNow = (await list(id)).body.data.find((k: { id: string }) => k.id === old.id);
      expect(oldNow.revoked_at).toBeNull();
      const graceMs = new Date(oldNow.expires_at).getTime() - Date.now();
      expect(graceMs).toBeGreaterThan(3500_000);
      expect(graceMs).toBeLessThanOrEqual(3600_000);
    });

    it('rotar la misma clave dos veces es 409; repetir la MISMA petición de rotación es 200 sin secreto y sin otra clave', async () => {
      const id = await createMerchant(ctx, 417);
      const old = (await create(id)).body;
      const key = uniqueKey();
      expect((await rotate(id, old.id, key)).status).toBe(201);
      const replay = await rotate(id, old.id, key);
      expect(replay.status).toBe(200);
      expect(replay.body).not.toHaveProperty('secret');
      expect((await rotate(id, old.id)).status).toBe(409);
      expect((await ctx.db.pool.query('SELECT 1 FROM api_keys WHERE merchant_id = $1', [id])).rows).toHaveLength(2);
    });

    it('el barrido revoca SOLO las que terminaron su gracia, con motivo rotated, una vez, aunque corran 5 a la vez', async () => {
      const id = await createMerchant(ctx, 418);
      const old = (await create(id)).body;
      const fresh = (await rotate(id, old.id)).body;
      const before = new Date();
      expect(await keys().sweepRotated(before)).toBe(0);
      expect((await row(old.id)).revoked_at).toBeNull();
      const after = new Date(Date.now() + 2 * 3600_000);
      // El barrido es global (toda la base): cuenta las vencidas de antes, de otras pruebas incluidas.
      const due = Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL AND grace_ends_at <= $1', [after])).rows[0].n);
      expect(due).toBeGreaterThanOrEqual(1);
      const swept = await Promise.all(Array.from({ length: 5 }, () => keys().sweepRotated(after)));
      expect(swept.reduce((a, b) => a + b, 0)).toBe(due);
      expect((await row(old.id)).revoked_at).not.toBeNull();
      expect((await row(old.id)).revoke_reason).toBe('rotated');
      expect((await row(fresh.id)).revoked_at).toBeNull();
      const events = await eventsOf(ctx, 'api_key.revoked', old.id);
      expect(events).toHaveLength(1);
      expect(events[0].data.reason).toBe('rotated');
      expect(await keys().sweepRotated(after)).toBe(0);
    });

    it('un comercio suspendido no puede rotar; rotar una clave ajena es 404', async () => {
      const id = await activeMerchant(ctx, 419);
      const other = await createMerchant(ctx, 420);
      const old = (await create(id)).body;
      expect((await rotate(other, old.id)).status).toBe(404);
      await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' });
      const res = await rotate(id, old.id);
      expect([res.status, res.body.code]).toEqual([403, 'merchant_suspended']);
      expect((await row(old.id)).grace_ends_at).toBeNull();
    });
  });

  it('GET /merchants/me cumple el contrato público y no expone datos de otro comercio', async () => {
    const id = await activeMerchant(ctx, 421);
    const other = await createMerchant(ctx, 422);
    const me = verified(ctx.publicContract, 'get', '/merchants/me', await pub(ctx, 'get', '/merchants/me', id), 200);
    expect(me).toMatchObject({ id, status: 'active', fee_schedule: { version: 0, channels: [] } });
    expect(JSON.stringify(me)).not.toContain(other);
    expect((await pub(ctx, 'get', '/merchants/me', 'mc_noexiste0000000000')).status).toBe(404);
  });
});
