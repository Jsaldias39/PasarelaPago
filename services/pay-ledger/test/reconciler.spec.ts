import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId } from './helpers/app';
import { CreateTransferStatus, createClient } from 'tigerbeetle-node';
import { accountTbId, txMeta } from './helpers/ids';
import { useIdNamespace, ownerTag, hash128 } from '../src/ledger/ids';
import { loadLedgerConfig } from '../src/ledger/ledger.config';
import { ReconcilerService, type ReconciliationReport } from '../src/ledger/reconciler.service';
import { type TigerBeetleEngine, plainTransfer } from '../src/ledger/tb-engine';
import { parseAccount } from '../src/ledger/accounts';
import { waitFor } from './helpers/wait';

/**
 * Reconciliador de recuperación TigerBeetle → Postgres (propuesta 25), con TigerBeetle y Postgres REALES.
 * La caída «TigerBeetle aplicó y Postgres no registró» se provoca de verdad: un trigger de PRUEBA (en el esquema desechable de esta suite) hace fallar el
 * INSERT/UPDATE de Postgres justo después de que el servicio ya aplicó en TigerBeetle. El servicio responde 500 y TigerBeetle queda por delante.
 */
useIdNamespace(`recon_${Math.random().toString(36).slice(2, 10)}`);

let ctx: LedgerTestContext;
let reconciler: ReconcilerService;
beforeAll(async () => {
  ctx = await createLedgerContext();
  reconciler = new ReconcilerService(ctx.db.pool, ctx.engine, { ...loadLedgerConfig(), payMode: 'sandbox' });
});
afterAll(async () => {
  await reconciler.stop();
  await ctx.close();
});

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code: string) => ({ debit_account, credit_account, amount_minor, code });
const txBody = (ref: string, legs: object[], attempt = 1) => ({ business_ref: ref, attempt, currency: 'BOB', legs });
const post = (caller: string, path: string, body: object, idem = key()) => ctx.as(caller).post(path, body).set('idempotency-key', idem);
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;
const count = async (table: string) => Number((await rows(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
const balance = async (account: string) => (checked(ctx, 'GET', '/balances', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(account)}`)).body as { balance_minor: number; pending_debits_minor: number });
/** Mira TODO el pasado (lookback 0) y no deja nada por «reciente» (grace 0): `now` se adelanta para absorber la diferencia de relojes. */
const reconcile = (mode: 'test' | 'live' = 'test', over: object = {}, svc: ReconcilerService = reconciler) => svc.reconcile(mode, { graceMs: 0, lookbackMs: 0, now: new Date(Date.now() + 2000), trigger: 'manual', ...over });
const stable = (r: ReconciliationReport) => JSON.stringify({ ...r, startedAt: undefined, finishedAt: undefined });

/** Postgres rechaza (a propósito) el próximo INSERT/UPDATE de esa operación: la caída entre TigerBeetle y Postgres. */
async function breakPostgres(table: 'ledger_transactions' | 'ledger_holds', when: string, event: 'INSERT' | 'UPDATE' = 'INSERT') {
  await repairPostgres(table);
  await ctx.db.pool.query(`CREATE OR REPLACE FUNCTION test_caida() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'caida inyectada por la prueba'; END $$`);
  await ctx.db.pool.query(`CREATE TRIGGER test_caida BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_caida()`);
}
afterEach(async () => {
  await repairPostgres('ledger_transactions');
  await repairPostgres('ledger_holds');
});
const repairPostgres = async (table: string) => ctx.db.pool.query(`DROP TRIGGER IF EXISTS test_caida ON ${table}`);

/** Un comercio con cuentas ya registradas (así el huérfano muestra nombres de cuenta) y saldo pendiente 100. */
async function seeded() {
  const m = merchantId();
  const res = await post('pay-payments', '/transactions', txBody(businessRef('seed'), [leg(CLEARING, `merchant:${m}:pending`, 100, 'charge')]));
  expect(res.status).toBe(201);
  return m;
}
async function funded(amount: number) {
  const m = merchantId();
  expect((await post('pay-payments', '/transactions', txBody(businessRef(), [leg(CLEARING, `merchant:${m}:pending`, amount, 'charge')]))).status).toBe(201);
  expect((await post('pay-settlement', '/transactions', txBody(businessRef(), [leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')]))).status).toBe(201);
  return m;
}

describe('correcto: sin divergencia no hace nada', () => {
  it('con el historial vacío y con operaciones normales (asiento de varias patas, retención aceptada, post) da `ok` y no escribe nada', async () => {
    expect(await reconcile()).toMatchObject({ status: 'ok', scanned: 0, orphans: [], resolutionAhead: [] });
    const m = await funded(1000);
    const hold = await post('pay-settlement', '/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 400, currency: 'BOB', expires_in_seconds: 60 });
    expect(hold.status).toBe(201);
    expect((await post('pay-settlement', `/holds/${hold.body.id}/post`, {})).status).toBe(200);
    expect((await post('pay-payments', '/transactions', txBody(businessRef(), [leg(CLEARING, `merchant:${m}:pending`, 970, 'charge'), leg(CLEARING, 'platform:fees', 30, 'fee')]))).status).toBe(201);

    const before = { tx: await count('ledger_transactions'), legs: await count('ledger_legs'), lines: await count('ledger_statement_lines'), accounts: await count('ledger_accounts'), holds: await count('ledger_holds'), outbox: await count('outbox_events') };
    const report = await reconcile();
    // 2 asientos de `funded` + 2 patas del último + retención (pendiente + post) = 6 transferencias en 4 operaciones
    expect(report).toMatchObject({ status: 'ok', mode: 'test', scanned: 6, groups: 4, matched: 4, orphans: [], resolutionAhead: [] });
    expect({ tx: await count('ledger_transactions'), legs: await count('ledger_legs'), lines: await count('ledger_statement_lines'), accounts: await count('ledger_accounts'), holds: await count('ledger_holds'), outbox: await count('outbox_events') }).toEqual(before);
    expect((await ctx.invariant.check()).ok).toBe(true);
  });
});

describe('límite: TigerBeetle por delante de Postgres', () => {
  it('UNA pata: se informa como huérfano (con nombres de cuenta e importe), no se escribe nada, y el reintento con la misma clave ADOPTA lo aplicado sin duplicar', async () => {
    const m = await seeded();
    const ref = businessRef();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    const crashed = await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 900, 'charge')]));
    expect(crashed.status).toBe(500);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(1000); // TigerBeetle ya movió: 100 + 900
    expect(await rows('SELECT 1 FROM ledger_legs WHERE business_ref = $1', [ref])).toHaveLength(0);

    const tables = { tx: await count('ledger_transactions'), legs: await count('ledger_legs'), accounts: await count('ledger_accounts') };
    const report = await reconcile();
    expect(report.status).toBe('diverged');
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({ mode: 'test', kind: 'transaction', totalMinor: '900', recoverable: false });
    expect(report.orphans[0].legs).toEqual([expect.objectContaining({ step: 'plain', amountMinor: '900', code: 'charge', debitAccount: CLEARING, creditAccount: `merchant:${m}:pending` })]);
    expect({ tx: await count('ledger_transactions'), legs: await count('ledger_legs'), accounts: await count('ledger_accounts') }).toEqual(tables); // no escribe
    expect((await ctx.invariant.check()).ok).toBe(false); // el invariante también lo ve: el extracto no coincide con TigerBeetle
    // alerta estructurada, sin business_ref ni datos de personas
    const alert = error.mock.calls.map((c) => c[0] as Record<string, unknown>).find((o) => o?.event === 'ledger.reconciliation.diverged');
    expect(alert).toMatchObject({ metric: { orphan_groups: 1, orphan_amount_minor: '900', resolution_ahead: 0 } });
    expect(JSON.stringify(alert)).not.toContain(ref);
    error.mockRestore();

    await repairPostgres('ledger_transactions');
    const retry = await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 900, 'charge')]));
    expect(retry.status).toBe(201);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(1000); // adoptó: NO 1900
    expect(await rows('SELECT 1 FROM ledger_legs WHERE business_ref = $1', [ref])).toHaveLength(1);
    expect(await reconcile()).toMatchObject({ status: 'ok', orphans: [] });
    expect((await ctx.invariant.check()).ok).toBe(true);
  });

  it('VARIAS patas enlazadas (cobro + comisión): un solo huérfano con las dos patas, y el reintento adopta el lote entero sin duplicar', async () => {
    const m = await seeded();
    const ref = businessRef();
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    const legs = [leg(CLEARING, `merchant:${m}:pending`, 970, 'charge'), leg(CLEARING, 'platform:fees', 30, 'fee')];
    expect((await post('pay-payments', '/transactions', txBody(ref, legs))).status).toBe(500);
    const report = await reconcile();
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({ kind: 'transaction', totalMinor: '1000' });
    expect(report.orphans[0].legs.map((l) => [l.code, l.amountMinor])).toEqual([['charge', '970'], ['fee', '30']]);

    await repairPostgres('ledger_transactions');
    const before = (await balance(`merchant:${m}:pending`)).balance_minor;
    expect((await post('pay-payments', '/transactions', txBody(ref, legs))).status).toBe(201);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(before);
    expect(await rows('SELECT 1 FROM ledger_legs WHERE business_ref = $1', [ref])).toHaveLength(2);
    expect(await reconcile()).toMatchObject({ status: 'ok' });
  });

  it('un contracargo partido (dos patas enlazadas, una a la cuenta de deuda) también se informa y se adopta', async () => {
    const m = await seeded(); // pending = 100
    const ref = businessRef('dispute');
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    const body = txBody(ref, [leg(`merchant:${m}:pending`, CLEARING, 150, 'adjustment')]);
    expect((await post('pay-payments', '/transactions', body)).status).toBe(500);
    const report = await reconcile();
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].legs).toHaveLength(2); // 100 de `pending` y 50 de deuda
    await repairPostgres('ledger_transactions');
    expect((await post('pay-payments', '/transactions', body)).status).toBe(201);
    expect(await reconcile()).toMatchObject({ status: 'ok' });
    expect((await ctx.invariant.check()).ok).toBe(true);
  });

  it('RETENCIÓN pendiente aplicada y no registrada: se informa (paso `pending`) y el reintento la adopta sin reservar dos veces', async () => {
    const m = await funded(1000);
    const body = { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 400, currency: 'BOB', expires_in_seconds: 60 };
    await breakPostgres('ledger_holds', `NEW.business_ref = '${body.business_ref}'`);
    expect((await post('pay-settlement', '/holds', body)).status).toBe(500);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(600); // reservado en TigerBeetle
    const report = await reconcile();
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({ kind: 'hold', totalMinor: '400' });
    expect(report.orphans[0].legs[0]).toMatchObject({ step: 'pending', amountMinor: '400' });

    await repairPostgres('ledger_holds');
    const retry = await post('pay-settlement', '/holds', body);
    expect(retry.status).toBe(201);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(600); // NO 200
    expect(await reconcile()).toMatchObject({ status: 'ok' });
  });

  it('una retención huérfana que YA VENCIÓ no es una alerta: TigerBeetle devolvió el monto solo; se cuenta como `expiredHolds` y el reintento (aún con la misma clave) no la resucita', async () => {
    const m = await funded(1000);
    const body = { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 300, currency: 'BOB', expires_in_seconds: 1 };
    await breakPostgres('ledger_holds', `NEW.business_ref = '${body.business_ref}'`);
    expect((await post('pay-settlement', '/holds', body)).status).toBe(500);
    expect((await reconcile('test', { now: new Date() })).orphans).toHaveLength(1); // todavía vigente: dinero retenido sin fila
    const lapsed = await waitFor(async () => {
      const r = await reconcile('test', { now: new Date(Date.now() + 1500) });
      return r.expiredHolds === 1 ? r : false;
    }, 15_000, 300);
    expect(lapsed).toMatchObject({ status: 'ok', orphans: [], expiredHolds: 1 });
    // …y TigerBeetle de verdad lo devuelve cuando vence (el reconciliador miró con un reloj adelantado; el real lo alcanza enseguida)
    await waitFor(async () => (await balance(`merchant:${m}:available`)).balance_minor === 1000, 15_000, 300);
  });

  it('SEGUNDA FASE aplicada y no registrada (Postgres dice `pending`, TigerBeetle ya la confirmó): se informa como resolución adelantada y el reintento con la misma clave la cierra', async () => {
    const m = await funded(1000);
    const hold = await post('pay-settlement', '/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 400, currency: 'BOB', expires_in_seconds: 60 });
    expect(hold.status).toBe(201);
    await breakPostgres('ledger_holds', `NEW.id = '${hold.body.id}' AND NEW.status = 'posted'`, 'UPDATE');
    const idem = key();
    expect((await post('pay-settlement', `/holds/${hold.body.id}/post`, {}, idem)).status).toBe(500);
    const report = await reconcile();
    expect(report.orphans).toEqual([]);
    expect(report.resolutionAhead).toEqual([expect.objectContaining({ holdId: hold.body.id, action: 'post', amountMinor: '400' })]);
    expect(report.status).toBe('diverged');

    await repairPostgres('ledger_holds');
    const retry = await post('pay-settlement', `/holds/${hold.body.id}/post`, {}, idem);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('posted');
    expect((await balance('payout:clearing')).balance_minor).toBeGreaterThanOrEqual(400);
    expect(await reconcile()).toMatchObject({ status: 'ok', resolutionAhead: [] });
  });

  it('lo MUY reciente (dentro del margen `graceMs`) no se informa: puede estar a mitad de camino hacia Postgres', async () => {
    const m = await seeded();
    const ref = businessRef();
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 5, 'charge')]))).status).toBe(500);
    expect((await reconcile('test', { graceMs: 60_000, now: new Date() })).orphans).toEqual([]);
    expect((await reconcile('test', { graceMs: 0 })).orphans).toHaveLength(1);
    await repairPostgres('ledger_transactions');
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 5, 'charge')]))).status).toBe(201);
  });
});

describe('inválido: lo que no es de este despliegue/modo se ignora; idempotencia; falla cerrado; una réplica', () => {
  const raw = (over: { id: string; debit: bigint; credit: bigint; ledger?: number; owner?: bigint; mode?: number; group?: bigint }) => ({
    id: hash128('foreign', over.id),
    debit_account_id: over.debit,
    credit_account_id: over.credit,
    amount: 7n,
    pending_id: 0n,
    user_data_128: over.group ?? hash128('foreign-group', over.id),
    user_data_64: over.owner ?? ownerTag(),
    user_data_32: over.mode ?? 1,
    timeout: 0,
    ledger: over.ledger ?? 1,
    code: 1,
    flags: 0,
    timestamp: 0n,
  });

  it('transferencias de OTRO despliegue, de OTRO ledger de TigerBeetle o sin marca no se leen ni se informan; las de OTRO modo de este despliegue solo aparecen al reconciliar ese modo', async () => {
    const a = `merchant:${merchantId()}:pending`;
    const b = 'platform:fees';
    await ctx.engine.ensureAccounts('test', [parseAccount(a)!, parseAccount(b)!]);
    const ids = { debit: accountTbId(b), credit: accountTbId(a) };
    const baseline = await reconcile();

    // otro despliegue y sin marca, en el ledger 1 con cuentas nuestras: TigerBeetle las aplica y el reconciliador no las ve
    const applied = await ctx.engine.createTransfers([raw({ id: 'otro-despliegue', ...ids, owner: ownerTag() + 1n }), raw({ id: 'sin-marca', ...ids, owner: 0n, mode: 0, group: 0n })]);
    expect(applied).toEqual([expect.any(Number), expect.any(Number)]);
    const found = await ctx.engine.lookupTransfers([hash128('foreign', 'otro-despliegue'), hash128('foreign', 'sin-marca')]);
    expect(found).toHaveLength(2); // existen de verdad en TigerBeetle

    // otro ledger (el 2): cuentas y transferencia reales, MARCADAS como de este despliegue y modo
    const tb = createClient({ cluster_id: 0n, replica_addresses: [process.env.TB_ADDRESS as string] });
    try {
      const acct = (id: string) => ({ id: hash128('acct2', id), debits_pending: 0n, debits_posted: 0n, credits_pending: 0n, credits_posted: 0n, user_data_128: 0n, user_data_64: 0n, user_data_32: 0, reserved: 0, ledger: 2, code: 1, flags: 0, timestamp: 0n });
      await tb.createAccounts([acct(a), acct(b)]);
      const [r] = await tb.createTransfers([raw({ id: 'otro-ledger', debit: hash128('acct2', b), credit: hash128('acct2', a), ledger: 2 })]);
      expect([CreateTransferStatus.created, CreateTransferStatus.exists]).toContain(r.status);
      expect(await tb.lookupTransfers([hash128('foreign', 'otro-ledger')])).toHaveLength(1);
    } finally {
      tb.destroy();
    }
    const after = await reconcile();
    expect(after).toMatchObject({ status: baseline.status, scanned: baseline.scanned, orphans: baseline.orphans });

    // …y la huérfana del modo `live` de ESTE despliegue: no aparece en `test`, sí al reconciliar `live`
    await ctx.engine.ensureAccounts('live', [parseAccount(a)!, parseAccount(b)!]);
    const liveLeg = plainTransfer({ id: hash128('live-orphan', a), debit: accountTbId(b, 'live'), credit: accountTbId(a, 'live'), amount: 42n, code: 'charge', meta: txMeta(businessRef(), 1, 'live') }, false);
    expect(await ctx.engine.createTransfers([liveLeg])).toEqual([expect.any(Number)]);
    expect((await reconcile('test')).orphans).toEqual(baseline.orphans);
    const live = await reconcile('live');
    expect(live.status).toBe('diverged');
    expect(live.orphans).toHaveLength(1);
    expect(live.orphans[0]).toMatchObject({ mode: 'live', totalMinor: '42' });
  });

  it('es idempotente: correrlo 3 veces con huérfanos pendientes da el MISMO resultado y no cambia Postgres ni TigerBeetle', async () => {
    const m = await seeded();
    const ref = businessRef();
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 33, 'charge')]))).status).toBe(500);
    const pg = async () => JSON.stringify([await count('ledger_transactions'), await count('ledger_legs'), await count('ledger_statement_lines'), await count('ledger_accounts'), await count('ledger_holds'), await count('outbox_events'), await count('ledger_rejections')]);
    const sansReloj = async () => ({ ...(await balance(`merchant:${m}:pending`)), as_of: undefined });
    const tbBefore = await sansReloj();
    const pgBefore = await pg();
    const runs = [await reconcile(), await reconcile(), await reconcile()];
    expect(runs[0].status).toBe('diverged');
    expect(stable(runs[1])).toBe(stable(runs[0]));
    expect(stable(runs[2])).toBe(stable(runs[0]));
    expect(await pg()).toBe(pgBefore);
    expect(await sansReloj()).toEqual(tbBefore);
    await repairPostgres('ledger_transactions');
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 33, 'charge')]))).status).toBe(201);
  });

  it('FALLA CERRADO: si no puede leer TigerBeetle o Postgres declara `failed`, no informa «ok» ni huérfanos a medias, y no escribe', async () => {
    const m = await seeded();
    const ref = businessRef();
    await breakPostgres('ledger_transactions', `NEW.business_ref = '${ref}'`);
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 8, 'charge')]))).status).toBe(500);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const brokenTb = { scanMarkedTransfers: async () => { throw new Error('TigerBeetle no respondió'); } } as unknown as TigerBeetleEngine;
    const tbFail = await reconcile('test', {}, new ReconcilerService(ctx.db.pool, brokenTb, { ...loadLedgerConfig(), payMode: 'sandbox' }));
    expect(tbFail).toMatchObject({ status: 'failed', scanned: 0, orphans: [], resolutionAhead: [] });
    expect(tbFail.detail).toContain('TigerBeetle no respondió');

    const midScan = { scanMarkedTransfers: async () => { await ctx.engine.scanMarkedTransfers('test', 0n, 0n); throw new Error('segunda página perdida'); } } as unknown as TigerBeetleEngine;
    expect((await reconcile('test', {}, new ReconcilerService(ctx.db.pool, midScan, { ...loadLedgerConfig(), payMode: 'sandbox' }))).status).toBe('failed');

    const brokenPool = { connect: async () => { throw new Error('sin conexión'); } } as unknown as typeof ctx.db.pool;
    const pgFail = await reconcile('test', {}, new ReconcilerService(brokenPool, ctx.engine, { ...loadLedgerConfig(), payMode: 'sandbox' }));
    expect(pgFail).toMatchObject({ status: 'failed', orphans: [] });

    const svc = new ReconcilerService(ctx.db.pool, brokenTb, { ...loadLedgerConfig(), payMode: 'sandbox' });
    await reconcile('test', {}, svc);
    expect(svc.metrics).toMatchObject({ runs: 1, failures: 1, lastCompleteAt: null });
    expect(error.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'ledger.reconciliation.failed')).toBe(true);
    error.mockRestore();

    // y cuando se puede leer otra vez, el mismo huérfano sigue ahí (el fallo no lo «limpió»)
    expect((await reconcile()).orphans.filter((o) => o.legs.some((l) => l.creditAccount === `merchant:${m}:pending`))).toHaveLength(1);
    await repairPostgres('ledger_transactions');
    expect((await post('pay-payments', '/transactions', txBody(ref, [leg(CLEARING, `merchant:${m}:pending`, 8, 'charge')]))).status).toBe(201);
  });

  it('UNA sola réplica: con el candado tomado por otra, el recorrido se omite (`skipped`) y no lee nada; al soltarlo, corre', async () => {
    const other = await ctx.db.pool.connect();
    try {
      const lockSql = `SELECT pg_advisory_lock(hashtext('ledger:reconciler:' || current_schema() || ':test'))`;
      await other.query(lockSql);
      const skipped = await reconcile();
      expect(skipped).toMatchObject({ status: 'skipped', scanned: 0, detail: 'otra réplica está reconciliando' });
      // el modo `live` tiene su propio candado
      expect((await reconcile('live')).status).not.toBe('skipped');
    } finally {
      await other.query(`SELECT pg_advisory_unlock_all()`);
      other.release();
    }
    expect((await reconcile()).status).not.toBe('skipped');
  });

  it('dentro de un mismo proceso no se pisan dos recorridos; `start` corre al arrancar y `stop` espera el recorrido en curso', async () => {
    const svc = new ReconcilerService(ctx.db.pool, ctx.engine, { ...loadLedgerConfig(), payMode: 'sandbox' });
    const [a, b] = await Promise.all([reconcile('test', {}, svc), reconcile('test', {}, svc)]);
    expect([a.status, b.status].filter((s) => s === 'skipped')).toHaveLength(1);
    svc.start(0, true);
    await waitFor(async () => svc.last?.trigger === 'startup', 15_000, 100);
    await svc.stop();
    expect(svc.last?.trigger).toBe('startup');
  });
});
