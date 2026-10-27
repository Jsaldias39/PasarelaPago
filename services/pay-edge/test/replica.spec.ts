import { randomBytes, randomUUID } from 'node:crypto';
import { connect, headers as natsHeaders, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import { generateApiKey } from '@pay/api-key';
import { ReplicaConsumer } from '../src/replica/replica.consumer';
import { parseReplicaEvent } from '../src/replica/replica.events';
import { startEdge, type EdgeHarness } from './harness';

/**
 * P1.H2.M1 — réplica de claves y estado de comercios a partir de eventos de pay-merchants, contra un NATS JetStream REAL
 * (stream, temas y consumidor propios de cada corrida) y Postgres/Redis reales. El publicador es un [DOBLE] de pay-merchants:
 * arma CloudEvents con la forma de contracts/asyncapi/merchants-schedules.yaml.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';

const cloudEvent = (type: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  specversion: '1.0',
  id: randomUUID(),
  source: '/pay-merchants',
  type,
  time: new Date().toISOString(),
  datacontenttype: 'application/json',
  data,
  ...overrides,
});

async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 5_000): Promise<{ value: T; elapsedMs: number }> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (accept(value)) return { value, elapsedMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`No se cumplió en ${timeoutMs} ms; último valor: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('[DOBLE] réplica de claves por eventos (NATS JetStream real)', () => {
  const suffix = randomBytes(4).toString('hex');
  const stream = `TEST_EDGE_${suffix}`;
  const prefix = `t${suffix}`;
  let nc: NatsConnection;
  let h: EdgeHarness;

  const publish = async (type: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}, msgId?: string) => {
    const event = cloudEvent(type, data, overrides);
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', msgId ?? String(event.id));
    await nc.jetstream().publish(`${prefix}.${type}`, JSON.stringify(event), { headers: hdrs });
    return event;
  };
  const publishRaw = (type: string, payload: string) => nc.jetstream().publish(`${prefix}.${type}`, payload);
  const status = async (token: string) => (await h.http().get('/v1/balance').set('Authorization', `Bearer ${token}`)).status;
  const created = (key: ReturnType<typeof generateApiKey>, merchantId: string) =>
    ({ key_id: key.keyId, merchant_id: merchantId, mode: key.mode, key_hash: key.keyHash });
  const newMerchant = () => `mc_${randomBytes(6).toString('hex')}`;
  const pending = async () => {
    const info = await (await nc.jetstreamManager()).consumers.info(stream, h.config.replica.durable);
    return { unprocessed: info.num_pending, inFlight: info.num_ack_pending };
  };

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, name: 'edge-replica-test' });
    await (await nc.jetstreamManager()).streams.add({ name: stream, subjects: [`${prefix}.>`], retention: RetentionPolicy.Limits, storage: StorageType.Memory, duplicate_window: 120_000_000_000 });
    h = await startEdge({ env: { NATS_URL, REPLICA_STREAM: stream, REPLICA_SUBJECT_PREFIX: prefix, REPLICA_DURABLE: `edge-${suffix}` } });
    await h.app.get(ReplicaConsumer).ready;
  });
  afterAll(async () => {
    await h.stop();
    await (await nc.jetstreamManager()).streams.delete(stream).catch(() => undefined);
    await nc.drain();
  });

  it('api_key.created: la clave pasa de 401 a 200 sin tocar la base a mano', async () => {
    const key = generateApiKey('test');
    const merchantId = newMerchant();
    expect(await status(key.token)).toBe(401);
    await publish('api_key.created', created(key, merchantId));
    await eventually(() => status(key.token), (s) => s === 200);
  });

  it('REQ-P1-3: una revocación deja de servir la clave en menos de 5 s', async () => {
    const key = generateApiKey('test');
    const merchantId = newMerchant();
    await publish('api_key.created', created(key, merchantId));
    await eventually(() => status(key.token), (s) => s === 200);

    await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: new Date().toISOString() });
    const { elapsedMs } = await eventually(() => status(key.token), (s) => s === 401);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('una revocación con instante FUTURO (gracia de rotación) sigue sirviendo hasta ese instante', async () => {
    const key = generateApiKey('test');
    const merchantId = newMerchant();
    await publish('api_key.created', created(key, merchantId));
    await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: new Date(Date.now() + 3_600_000).toISOString() });
    await eventually(() => h.db.pool.query('SELECT 1 FROM api_key_replica WHERE key_id = $1 AND revoked_at IS NOT NULL AND key_hash IS NOT NULL', [key.keyId]), (r) => r.rowCount === 1);
    expect(await status(key.token)).toBe(200);
  });

  it('DESORDEN: la revocación llega ANTES que la creación y la clave no resucita', async () => {
    const key = generateApiKey('test');
    const merchantId = newMerchant();
    await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: new Date(Date.now() - 1_000).toISOString() });
    await publish('api_key.created', created(key, merchantId));
    await eventually(() => h.db.pool.query('SELECT key_hash FROM api_key_replica WHERE key_id = $1', [key.keyId]), (r) => r.rows[0]?.key_hash !== null && r.rows[0]?.key_hash !== undefined);
    expect(await status(key.token)).toBe(401);
  });

  it('la revocación más temprana manda: una segunda revocación posterior no la deshace ni la relaja', async () => {
    const key = generateApiKey('test');
    const merchantId = newMerchant();
    await publish('api_key.created', created(key, merchantId));
    const early = new Date(Date.now() - 60_000).toISOString();
    await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: early });
    await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: new Date(Date.now() + 3_600_000).toISOString() });
    await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
    const row = await h.db.pool.query('SELECT revoked_at FROM api_key_replica WHERE key_id = $1', [key.keyId]);
    expect(new Date(row.rows[0].revoked_at).toISOString()).toBe(early);
    expect(await status(key.token)).toBe(401);
  });

  it('un hash replicado no se pisa: un segundo api_key.created con otro hash NO reemplaza la credencial', async () => {
    const key = generateApiKey('test');
    const attacker = generateApiKey('test');
    const merchantId = newMerchant();
    await publish('api_key.created', created(key, merchantId));
    await eventually(() => status(key.token), (s) => s === 200);
    await publish('api_key.created', { key_id: key.keyId, merchant_id: merchantId, mode: 'test', key_hash: attacker.keyHash });
    await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
    expect(await status(key.token)).toBe(200);
    expect(await status(attacker.token)).toBe(401);
  });

  it('el mismo evento entregado dos veces (ids de NATS distintos) tiene UN solo efecto: lo garantiza el inbox', async () => {
    const key = generateApiKey('test');
    const event = cloudEvent('api_key.created', created(key, newMerchant()));
    for (const msgId of [`a-${event.id}`, `b-${event.id}`]) {
      const hdrs = natsHeaders();
      hdrs.set('Nats-Msg-Id', msgId);
      await nc.jetstream().publish(`${prefix}.api_key.created`, JSON.stringify(event), { headers: hdrs });
    }
    await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
    const inbox = await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id]);
    expect(inbox.rows[0].n).toBe(1);
    expect(await status(key.token)).toBe(200);
  });

  describe('eventos inválidos: se descartan (term), no se reintentan y no frenan al resto', () => {
    const key = () => generateApiKey('test');
    it.each([
      ['no es JSON', () => publishRaw('api_key.created', 'esto no es json')],
      ['sin hash', () => publish('api_key.created', { key_id: key().keyId, merchant_id: newMerchant(), mode: 'test' })],
      ['hash con formato inválido', () => publish('api_key.created', { ...created(key(), newMerchant()), key_hash: 'md5$abc' })],
      ['origen que no es pay-merchants', () => publish('api_key.created', created(key(), newMerchant()), { source: '/pay-payments' })],
      ['modo desconocido', () => publish('api_key.created', { ...created(key(), newMerchant()), mode: 'prod' })],
      ['id de evento que no es UUID', () => publish('api_key.created', created(key(), newMerchant()), { id: 'no-uuid' })],
      ['specversion distinta', () => publish('api_key.created', created(key(), newMerchant()), { specversion: '0.3' })],
      ['revocación con fecha inválida', () => publish('api_key.revoked', { key_id: key().keyId, merchant_id: newMerchant(), mode: 'test', revoked_at: 'ayer' })],
    ])('%s', async (_name, send) => {
      await send();
      const valid = key();
      await publish('api_key.created', created(valid, newMerchant()));
      await eventually(() => status(valid.token), (s) => s === 200);
      const state = await pending();
      expect(state).toEqual({ unprocessed: 0, inFlight: 0 });
    });
  });

  describe('estado del comercio', () => {
    it('merchant.suspended ⇒ 403 en la siguiente petición; merchant.activated posterior ⇒ 200', async () => {
      const key = generateApiKey('test');
      const merchantId = newMerchant();
      await publish('api_key.created', created(key, merchantId));
      await eventually(() => status(key.token), (s) => s === 200);

      const t0 = Date.now();
      await publish('merchant.suspended', { merchant_id: merchantId, suspended_at: new Date(t0).toISOString() });
      await eventually(() => status(key.token), (s) => s === 403);
      await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 + 1_000).toISOString() });
      await eventually(() => status(key.token), (s) => s === 200);
    });

    it('un evento más VIEJO que el estado guardado no lo pisa (suspendido ⇒ un activated anterior llega tarde y se ignora)', async () => {
      const key = generateApiKey('test');
      const merchantId = newMerchant();
      await publish('api_key.created', created(key, merchantId));
      const t0 = Date.now();
      await publish('merchant.suspended', { merchant_id: merchantId, suspended_at: new Date(t0).toISOString() });
      await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 - 60_000).toISOString() });
      await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
      expect(await status(key.token)).toBe(403);
    });

    it('closed es terminal: ningún activated posterior reabre un comercio cerrado', async () => {
      const key = generateApiKey('test');
      const merchantId = newMerchant();
      await publish('api_key.created', created(key, merchantId));
      const t0 = Date.now();
      await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date(t0).toISOString() });
      await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 + 60_000).toISOString() });
      await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
      expect(await status(key.token)).toBe(401);
      const row = await h.db.pool.query('SELECT status FROM merchant_replica WHERE merchant_id = $1', [merchantId]);
      expect(row.rows[0].status).toBe('closed');
    });
  });

  /**
   * D-32 — cerrar un comercio REVOCA sus claves; suspender solo las bloquea y se revierte. Tres niveles (regla 65): correcto,
   * límite e inválido, contra NATS/Postgres/Redis reales; el publicador es el [DOBLE] de pay-merchants de este archivo.
   */
  describe('D-32: cierre revoca las claves, suspensión solo bloquea', () => {
    const seedActive = async () => {
      const key = generateApiKey('test');
      const merchantId = newMerchant();
      await publish('api_key.created', created(key, merchantId));
      await eventually(() => status(key.token), (s) => s === 200);
      return { key, merchantId };
    };
    const revokedAt = async (keyId: string) => (await h.db.pool.query('SELECT revoked_at FROM api_key_replica WHERE key_id = $1', [keyId])).rows[0]?.revoked_at as Date | null | undefined;

    describe('nivel correcto', () => {
      it('merchant.closed ⇒ 401 en menos de 5 s, y la réplica deja revocadas TODAS las claves del comercio (test y live)', async () => {
        const { key, merchantId } = await seedActive();
        const live = generateApiKey('live');
        await publish('api_key.created', created(live, merchantId));
        await eventually(() => revokedAt(live.keyId), (v) => v === null);

        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date().toISOString() });
        const { elapsedMs } = await eventually(() => status(key.token), (s) => s === 401);
        expect(elapsedMs).toBeLessThan(5_000);
        expect(await revokedAt(key.keyId)).toBeInstanceOf(Date);
        expect(await revokedAt(live.keyId)).toBeInstanceOf(Date);
      });

      it('merchant.suspended ⇒ 403 (bloqueada) SIN tocar las claves; merchant.activated ⇒ 200 (restaurada)', async () => {
        const { key, merchantId } = await seedActive();
        const t0 = Date.now();
        await publish('merchant.suspended', { merchant_id: merchantId, suspended_at: new Date(t0).toISOString() });
        await eventually(() => status(key.token), (s) => s === 403);
        expect(await revokedAt(key.keyId)).toBeNull();
        await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 + 1_000).toISOString() });
        await eventually(() => status(key.token), (s) => s === 200);
      });

      it('el ciclo completo: activa ⇒ suspendida (403) ⇒ reactivada (200) ⇒ cerrada (401 para siempre)', async () => {
        const { key, merchantId } = await seedActive();
        const t0 = Date.now();
        await publish('merchant.suspended', { merchant_id: merchantId, suspended_at: new Date(t0).toISOString() });
        await eventually(() => status(key.token), (s) => s === 403);
        await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 + 1_000).toISOString() });
        await eventually(() => status(key.token), (s) => s === 200);
        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date(t0 + 2_000).toISOString() });
        await eventually(() => status(key.token), (s) => s === 401);
        await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0 + 3_000).toISOString() });
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        expect(await status(key.token)).toBe(401);
      });
    });

    describe('nivel límite', () => {
      it('la clave que llega DESPUÉS de merchant.closed (api_key.created tardío) tampoco sirve', async () => {
        const merchantId = newMerchant();
        const key = generateApiKey('test');
        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date().toISOString() });
        await publish('api_key.created', created(key, merchantId));
        await eventually(() => h.db.pool.query('SELECT 1 FROM api_key_replica WHERE key_id = $1', [key.keyId]), (r) => r.rowCount === 1);
        expect(await status(key.token)).toBe(401);
      });

      it('un merchant.closed con instante ANTERIOR al estado guardado igual gana (cerrado es terminal en el origen)', async () => {
        const { key, merchantId } = await seedActive();
        const t0 = Date.now();
        await publish('merchant.activated', { merchant_id: merchantId, activated_at: new Date(t0).toISOString() });
        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date(t0 - 60_000).toISOString() });
        await eventually(() => status(key.token), (s) => s === 401);
        const row = await h.db.pool.query('SELECT status FROM merchant_replica WHERE merchant_id = $1', [merchantId]);
        expect(row.rows[0].status).toBe('closed');
      });

      it('una revocación individual MÁS temprana que el cierre se conserva (LEAST): el cierre no la relaja', async () => {
        const { key, merchantId } = await seedActive();
        const early = new Date(Date.now() - 3_600_000).toISOString();
        await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: early });
        await eventually(() => status(key.token), (s) => s === 401);
        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date().toISOString() });
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        expect((await revokedAt(key.keyId))?.toISOString()).toBe(early);
      });

      it('el cierre de un comercio NO toca las claves de otro comercio', async () => {
        const a = await seedActive();
        const b = await seedActive();
        await publish('merchant.closed', { merchant_id: a.merchantId, closed_at: new Date().toISOString() });
        await eventually(() => status(a.key.token), (s) => s === 401);
        expect(await status(b.key.token)).toBe(200);
        expect(await revokedAt(b.key.keyId)).toBeNull();
      });

      it('el mismo merchant.closed entregado dos veces tiene un solo efecto (inbox) y es idempotente', async () => {
        const { key, merchantId } = await seedActive();
        const event = cloudEvent('merchant.closed', { merchant_id: merchantId, closed_at: new Date().toISOString() });
        for (const msgId of ['a', 'b']) {
          const hdrs = natsHeaders();
          hdrs.set('Nats-Msg-Id', `${event.id}-${msgId}`);
          await nc.jetstream().publish(`${prefix}.merchant.closed`, JSON.stringify(event), { headers: hdrs });
        }
        await eventually(() => status(key.token), (s) => s === 401);
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        const inbox = await h.db.pool.query(`SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1`, [event.id]);
        expect(inbox.rows[0].n).toBe(1);
      });
    });

    describe('nivel inválido', () => {
      it.each([
        ['merchant_id con formato de inyección', { merchant_id: "mc_x'; UPDATE api_key_replica SET revoked_at=NULL;--", closed_at: new Date().toISOString() }],
        ['sin merchant_id', { closed_at: new Date().toISOString() }],
        ['closed_at que no es una fecha', { merchant_id: 'mc_aaaaaaaaaaaa', closed_at: 'mañana' }],
        ['sin closed_at', { merchant_id: 'mc_aaaaaaaaaaaa' }],
      ])('merchant.closed mal formado (%s) se descarta sin revocar nada ni frenar el consumo', async (_name, data) => {
        const { key } = await seedActive();
        await publish('merchant.closed', data);
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        expect(await status(key.token)).toBe(200);
      });

      it('un merchant.closed con fuente falsificada (source distinta de /pay-merchants) no revoca nada', async () => {
        const { key, merchantId } = await seedActive();
        await publish('merchant.closed', { merchant_id: merchantId, closed_at: new Date().toISOString() }, { source: '/pay-evil' });
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        expect(await status(key.token)).toBe(200);
      });

      it('un merchant.closed de un comercio desconocido para la réplica se acepta sin error y no afecta a otros', async () => {
        const { key } = await seedActive();
        await publish('merchant.closed', { merchant_id: newMerchant(), closed_at: new Date().toISOString() });
        await eventually(() => pending(), (p) => p.unprocessed === 0 && p.inFlight === 0);
        expect(await status(key.token)).toBe(200);
      });
    });
  });
});

describe('parseReplicaEvent (función pura)', () => {
  const base = { specversion: '1.0', id: randomUUID(), source: '/pay-merchants' };
  const key = generateApiKey('live');

  it('acepta los cinco tipos del contrato', () => {
    const m = 'mc_abcdefghij12';
    expect(parseReplicaEvent({ ...base, type: 'api_key.created', data: { key_id: key.keyId, merchant_id: m, mode: 'live', key_hash: key.keyHash } })?.kind).toBe('api_key.created');
    expect(parseReplicaEvent({ ...base, type: 'api_key.revoked', data: { key_id: key.keyId, merchant_id: m, mode: 'live', revoked_at: '2026-10-27T10:00:00Z' } })?.kind).toBe('api_key.revoked');
    for (const [type, field, status] of [['merchant.activated', 'activated_at', 'active'], ['merchant.suspended', 'suspended_at', 'suspended'], ['merchant.closed', 'closed_at', 'closed']] as const) {
      expect(parseReplicaEvent({ ...base, type, data: { merchant_id: m, [field]: '2026-10-27T10:00:00Z' } })).toMatchObject({ kind: 'merchant.status', status });
    }
  });

  it.each([null, undefined, 'texto', 42, [], {}, { ...base, type: 'merchant.deleted', data: {} }, { ...base, type: 'api_key.created', data: null }])('rechaza %j sin lanzar', (raw) => {
    expect(parseReplicaEvent(raw)).toBeNull();
  });

  it('rechaza identificadores con formato inválido (inyección en ids)', () => {
    expect(parseReplicaEvent({ ...base, type: 'merchant.closed', data: { merchant_id: "mc_x'; DROP TABLE api_key_replica;--", closed_at: '2026-10-27T10:00:00Z' } })).toBeNull();
  });
});
