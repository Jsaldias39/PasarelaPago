import { randomBytes } from 'node:crypto';
import { connect, type NatsConnection } from 'nats';
import { NatsEventPublisher, OutboxRelay, ensureStream } from '@pay/outbox';
import { parseAccount } from '../src/ledger/accounts';
import { type LedgerTestContext, businessRef, createLedgerContext, merchantId } from './helpers/app';
import { type EventValidator, loadEventValidators } from './helpers/events-contract';

let ctx: LedgerTestContext;
let validators: Map<string, EventValidator>;
let nc: NatsConnection;
beforeAll(async () => {
  ctx = await createLedgerContext();
  validators = await loadEventValidators('ledger-settlement.yaml');
  nc = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:54222' });
});
afterAll(async () => {
  await nc.drain();
  await ctx.close();
});

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code: string) => ({ debit_account, credit_account, amount_minor, code });
const post = (legs: object[], caller = 'pay-payments') =>
  ctx.as(caller).post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs }).set('idempotency-key', key());
const events = async (ids: string[] = []) =>
  (await ctx.db.pool.query("SELECT type, subject, envelope, published_at FROM outbox_events WHERE aggregate_id = ANY($1) OR $2::boolean ORDER BY seq", [ids, ids.length === 0])).rows;

describe('eventos del ledger (outbox, en la misma transacción)', () => {
  it('un asiento de cobro + comisión publica un ledger.transfer.posted POR PATA, válido contra el AsyncAPI, con kind y merchantid correctos', async () => {
    const m = merchantId();
    const res = await post([leg(CLEARING, `merchant:${m}:pending`, 9700, 'charge'), leg(CLEARING, 'platform:fees', 300, 'fee')]);
    expect(res.status).toBe(201);
    const out = (await events()).filter((e) => e.type === 'ledger.transfer.posted');
    expect(out).toHaveLength(2);
    const validate = validators.get('ledger.transfer.posted') as EventValidator;
    for (const row of out) expect(validate(row.envelope)).toEqual([]);
    const [capture, fee] = out.map((e) => e.envelope);
    expect(capture.data).toMatchObject({ kind: 'capture', debit_account: CLEARING, credit_account: `merchant:${m}:pending`, amount_minor: 9700, currency: 'BOB', attempt: 1 });
    expect(capture.merchantid).toBe(m);
    expect(capture.subject).toBe(capture.data.transfer_id);
    expect(fee.data.kind).toBe('fee');
    expect(fee.merchantid).toBeUndefined(); // ninguna cuenta del movimiento es de un comercio
    expect(out[0].subject).toBe('pay-ledger.ledger.transfer.posted');
  });

  it('un movimiento `release` (pending → available) no publica evento: el contrato de eventos no tiene ese kind (PROPUESTAS.md #2)', async () => {
    const m = merchantId();
    await post([leg(CLEARING, `merchant:${m}:pending`, 500, 'charge')]);
    const before = (await events()).filter((e) => e.type === 'ledger.transfer.posted').length;
    expect((await post([leg(`merchant:${m}:pending`, `merchant:${m}:available`, 500, 'release')], 'pay-settlement')).status).toBe(201);
    expect((await events()).filter((e) => e.type === 'ledger.transfer.posted')).toHaveLength(before);
  });

  it('un rechazo NO deja evento: sin asiento no hay evento', async () => {
    const m = merchantId();
    const before = (await events()).length;
    const res = await post([leg(`merchant:${m}:available`, 'payout:clearing', 10, 'payout')], 'pay-settlement');
    expect(res.status).toBe(422);
    expect(await events()).toHaveLength(before);
  });

  it('los eventos de retención (created, posted, voided) cumplen el AsyncAPI', async () => {
    const m = merchantId();
    await post([leg(CLEARING, `merchant:${m}:pending`, 4000, 'charge')]);
    await post([leg(`merchant:${m}:pending`, `merchant:${m}:available`, 4000, 'release')], 'pay-settlement');
    const create = async (amount: number) =>
      (await ctx.as('pay-settlement').post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: amount, currency: 'BOB', expires_in_seconds: 60 }).set('idempotency-key', key())).body;
    const h1 = await create(1000);
    const h2 = await create(1000);
    await ctx.as('pay-settlement').post(`/holds/${h1.id}/post`).set('idempotency-key', key());
    await ctx.as('pay-settlement').post(`/holds/${h2.id}/void`).set('idempotency-key', key());
    const rows = await events([h1.id, h2.id]);
    expect(rows.map((r) => r.type).sort()).toEqual(['ledger.hold.created', 'ledger.hold.created', 'ledger.hold.posted', 'ledger.hold.voided']);
    for (const row of rows) {
      const validate = validators.get(row.type) as EventValidator;
      expect(validate(row.envelope)).toEqual([]);
    }
    const posted = rows.find((r) => r.type === 'ledger.hold.posted');
    expect(posted?.envelope.data.transfer_id).toMatch(/^tf_[a-z0-9]{10,40}$/);
  });

  it('el relé del outbox lleva los eventos a NATS JetStream, en orden y una sola vez', async () => {
    const tag = randomBytes(4).toString('hex');
    const m = merchantId();
    for (let i = 1; i <= 3; i += 1) await post([leg(CLEARING, `merchant:${m}:pending`, i, 'charge')]);
    // Se redirige a un stream propio de la prueba para no chocar con el stream real PAY_LEDGER del servicio.
    await ctx.db.pool.query("UPDATE outbox_events SET subject = $1 || '.' || type WHERE published_at IS NULL", [`t-${tag}`]);
    const pending = Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL')).rows[0].n);
    const jsm = await nc.jetstreamManager();
    await ensureStream(jsm, `T_${tag}`, [`t-${tag}.>`]);
    const relay = new OutboxRelay(ctx.db.pool, new NatsEventPublisher(nc));
    expect(await relay.drainOnce()).toBe(pending);
    expect(await relay.drainOnce()).toBe(0);
    const info = await jsm.streams.info(`T_${tag}`);
    expect(info.state.messages).toBe(pending);
    await jsm.streams.delete(`T_${tag}`);
  });

  it('merchantid sale del lado crédito si lo hay y del débito si no', () => {
    expect(parseAccount('merchant:mc_k3m9x2q7ab:pending')?.merchantId).toBe('mc_k3m9x2q7ab');
  });
});

describe('`mode` en los eventos (D-28): apagado hasta que el AsyncAPI lo declare, listo para encenderse', () => {
  const all = async () => (await ctx.db.pool.query('SELECT type, envelope FROM outbox_events ORDER BY seq')).rows as { type: string; envelope: { data: Record<string, unknown> } }[];
  const exercise = async (mode: 'test' | 'live') => {
    const m = merchantId();
    const tx = (legs: object[], caller = 'pay-payments') => ctx.as(caller, mode).post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs }).set('idempotency-key', key());
    await tx([leg(CLEARING, `merchant:${m}:pending`, 900, 'charge')]);
    await tx([leg(`merchant:${m}:pending`, `merchant:${m}:available`, 900, 'release')], 'pay-settlement');
    const hold = (amount: number) => ctx.as('pay-settlement', mode).post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: amount, currency: 'BOB', expires_in_seconds: 60 }).set('idempotency-key', key());
    const h1 = await hold(100);
    await ctx.as('pay-settlement', mode).post(`/holds/${h1.body.id}/post`).set('idempotency-key', key());
    const h2 = await hold(100);
    await ctx.as('pay-settlement', mode).post(`/holds/${h2.body.id}/void`).set('idempotency-key', key());
    await hold(100);
    await ctx.holds.sweepExpired(0, new Date(Date.now() + 120_000));
  };
  const TYPES = ['ledger.transfer.posted', 'ledger.hold.created', 'ledger.hold.posted', 'ledger.hold.voided', 'ledger.hold.expired'];

  it('por defecto NO sale `mode` y todos los eventos validan contra el contrato de hoy', async () => {
    const before = (await all()).length;
    await exercise('live');
    const fresh = (await all()).slice(before);
    expect(new Set(fresh.map((e) => e.type))).toEqual(new Set(TYPES));
    for (const e of fresh) {
      expect(e.envelope.data).not.toHaveProperty('mode');
      expect((validators.get(e.type) as EventValidator)(e.envelope)).toEqual([]);
    }
  });

  it.each(['test', 'live'] as const)('encendido (EVENTS_CARRY_MODE) cada evento lleva el modo %s de su asiento o retención; contra el contrato solo puede diferir en `mode`', async (mode) => {
    const { setEventsCarryMode } = await import('../src/ledger/event-mode');
    setEventsCarryMode(true);
    try {
      const before = (await all()).length;
      await exercise(mode);
      const fresh = (await all()).slice(before);
      expect(new Set(fresh.map((e) => e.type))).toEqual(new Set(TYPES));
      for (const e of fresh) {
        expect(e.envelope.data.mode).toBe(mode);
        // Mientras el contrato no lo declare, el ÚNICO error es `mode`; cuando lo declare, no habrá ninguno (esta prueba sirve de canario).
        const errors = (validators.get(e.type) as EventValidator)(e.envelope);
        expect(errors.filter((x) => !/additional propert|\bmode\b/i.test(x))).toEqual([]);
      }
    } finally {
      setEventsCarryMode(false);
    }
  });
});
