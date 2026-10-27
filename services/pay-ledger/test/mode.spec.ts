import { useIdNamespace } from '../src/ledger/ids';
import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId, unique } from './helpers/app';
import { accountTbId } from './helpers/ids';

/**
 * Modo de la operación (D-28): `X-Pay-Mode: test|live` lo fija `pay-edge`; el ledger lo exige en TODAS las rutas y separa por modo los
 * asientos, las retenciones, los saldos y los extractos. Tres niveles: correcto, límite e inválido, incluida la negativa test↔live.
 */
let ctx: LedgerTestContext;
beforeAll(async () => {
  // TigerBeetle es compartido con las demás suites: el invariante solo cierra si las cuentas de plataforma son de este proceso.
  useIdNamespace(`mode_${unique()}`);
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

type Mode = 'test' | 'live';
const MODES: Mode[] = ['test', 'live'];
const other = (mode: Mode): Mode => (mode === 'test' ? 'live' : 'test');
const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code = 'charge') => ({ debit_account, credit_account, amount_minor, code });
const body = (ref: string, attempt: number, legs: object[]) => ({ business_ref: ref, attempt, currency: 'BOB', legs });
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

const tx = async (mode: Mode | null, payload: object, caller = 'pay-payments') =>
  checked(ctx, 'POST', '/transactions', await ctx.as(caller, mode).post('/transactions', payload).set('idempotency-key', key()));
const balance = async (mode: Mode | null, account: string) => checked(ctx, 'GET', '/balances', await ctx.as('pay-settlement', mode).get(`/balances?account=${encodeURIComponent(account)}`));
const hold = async (mode: Mode | null, payload: object) => checked(ctx, 'POST', '/holds', await ctx.as('pay-settlement', mode).post('/holds', payload).set('idempotency-key', key()));
const holdBody = (m: string, amount: number, over: object = {}) => ({
  business_ref: businessRef('payout'),
  attempt: 1,
  debit_account: `merchant:${m}:available`,
  credit_account: 'payout:clearing',
  amount_minor: amount,
  currency: 'BOB',
  expires_in_seconds: 120,
  ...over,
});

/** Cobro + liberación: deja `amount` disponibles al comercio EN ESE MODO. */
async function fundAvailable(mode: Mode, m: string, amount: number) {
  expect((await tx(mode, body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, amount)]))).status).toBe(201);
  expect((await tx(mode, body(businessRef('release'), 1, [leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')]), 'pay-settlement')).status).toBe(201);
}

describe('correcto: el modo válido opera y los dos modos son independientes', () => {
  it.each(MODES)('en modo %s todas las rutas internas responden con su contrato', async (mode) => {
    const m = merchantId();
    await fundAvailable(mode, m, 5000);
    const ref = businessRef('payout');
    const h = await hold(mode, holdBody(m, 1000, { business_ref: ref }));
    expect(h.status).toBe(201);
    expect(checked(ctx, 'GET', `/holds/${h.body.id}`, await ctx.as('pay-settlement', mode).get(`/holds/${h.body.id}`)).status).toBe(200);
    const posted = checked(ctx, 'POST', `/holds/${h.body.id}/post`, await ctx.as('pay-settlement', mode).post(`/holds/${h.body.id}/post`).set('idempotency-key', key()));
    expect(posted.body).toMatchObject({ status: 'posted' });
    expect(checked(ctx, 'GET', '/transactions/x', await ctx.as('pay-payments', mode).get(`/transactions/${encodeURIComponent(ref)}`)).status).toBe(404); // el hold no es un asiento
    const statement = checked(ctx, 'GET', '/statements', await ctx.as('pay-settlement', mode).get(`/statements?account=${encodeURIComponent(`merchant:${m}:available`)}`));
    expect(statement.body.data).toHaveLength(2); // liberación (crédito) y retención posteada (débito)
    expect((await balance(mode, `merchant:${m}:available`)).body.balance_minor).toBe(4000);
    expect((await ctx.as('pay-edge', mode).get('/balance').set('x-merchant-id', m)).body).toMatchObject({ available_minor: 4000, pending_minor: 0 });
  });

  it('el MISMO business_ref, intento y cuentas en test y en live son dos asientos distintos, con ids distintos y saldos independientes', async () => {
    const m = merchantId();
    const ref = businessRef();
    const payload = body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 700)]);
    const [t, l] = [await tx('test', payload), await tx('live', { ...payload, legs: [leg(CLEARING, `merchant:${m}:pending`, 300)] })];
    expect([t.status, l.status]).toEqual([201, 201]); // ni `exists` ni 422 por «otro contenido»: no comparten identidad
    expect(t.body.id).not.toBe(l.body.id);
    expect((await balance('test', `merchant:${m}:pending`)).body.balance_minor).toBe(700);
    expect((await balance('live', `merchant:${m}:pending`)).body.balance_minor).toBe(300);
    expect(await count('SELECT count(*) AS n FROM ledger_accounts WHERE account = $1', [`merchant:${m}:pending`])).toBe(2);
    expect((await ctx.as('pay-edge', 'test').get('/balance').set('x-merchant-id', m)).body.pending_minor).toBe(700);
    expect((await ctx.as('pay-edge', 'live').get('/balance').set('x-merchant-id', m)).body.pending_minor).toBe(300);
  });

  it('el invariante global verifica los dos modos por separado y cierra sin diferencias', async () => {
    const m = merchantId();
    await fundAvailable('test', m, 900);
    await fundAvailable('live', m, 1100);
    const report = await ctx.invariant.check();
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('un contracargo partido (pendiente + deuda) opera dentro de su modo y no toca el otro', async () => {
    const m = merchantId();
    const CB = 'connector:mercantil_qr:clearing';
    for (const mode of MODES) expect((await tx(mode, body(businessRef(), 1, [leg(CB, `merchant:${m}:pending`, 100)]))).status).toBe(201);
    const res = await tx('test', body(businessRef('dispute'), 1, [leg(`merchant:${m}:pending`, CB, 160, 'adjustment')]), 'pay-payments');
    expect(res.status).toBe(201);
    expect((await balance('test', `merchant:${m}:debt`)).body.balance_minor).toBe(60);
    expect((await balance('live', `merchant:${m}:pending`)).body.balance_minor).toBe(100);
    expect((await balance('live', `merchant:${m}:debt`)).status).toBe(404); // en live la cuenta de deuda ni existe
  });
});

describe('límite: el dinero y los registros de un modo NO se ven ni se gastan desde el otro (test↔live, en los dos sentidos)', () => {
  it.each(MODES)('el dinero cargado en %s no se puede gastar en el modo contrario: rechazo por saldo y nada se mueve', async (mode) => {
    const m = merchantId();
    await fundAvailable(mode, m, 5000);
    const otherMode = other(mode);
    // Retención y asiento sobre una cuenta que en el otro modo no tiene saldo.
    const h = await hold(otherMode, holdBody(m, 100));
    expect(h.status).toBe(422);
    expect(h.body.code).toBe('insufficient_funds');
    const t = await tx(otherMode, body(businessRef('payout'), 1, [leg(`merchant:${m}:available`, 'payout:clearing', 100, 'payout')]), 'pay-settlement');
    expect(t.status).toBe(422);
    expect(t.body.code).toBe('insufficient_funds');
    expect((await balance(mode, `merchant:${m}:available`)).body.balance_minor).toBe(5000);
  });

  it.each(MODES)('un saldo y un extracto creados en %s no existen en el modo contrario (404, sin revelar nada)', async (mode) => {
    const m = merchantId();
    await fundAvailable(mode, m, 800);
    const acct = encodeURIComponent(`merchant:${m}:available`);
    expect((await balance(other(mode), `merchant:${m}:available`)).status).toBe(404);
    const statement = checked(ctx, 'GET', '/statements', await ctx.as('pay-settlement', other(mode)).get(`/statements?account=${acct}`));
    expect(statement.status).toBe(404);
    expect((await ctx.as('pay-edge', other(mode)).get('/balance').set('x-merchant-id', m)).body).toMatchObject({ available_minor: 0, pending_minor: 0 });
  });

  it.each(MODES)('un asiento de %s no se consulta con el modo contrario (404)', async (mode) => {
    const m = merchantId();
    const ref = businessRef();
    expect((await tx(mode, body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 50)]))).status).toBe(201);
    expect(checked(ctx, 'GET', '/transactions/x', await ctx.as('pay-payments', mode).get(`/transactions/${encodeURIComponent(ref)}`)).status).toBe(200);
    expect(checked(ctx, 'GET', '/transactions/x', await ctx.as('pay-payments', other(mode)).get(`/transactions/${encodeURIComponent(ref)}`)).status).toBe(404);
  });

  it.each(MODES)('una retención de %s no se consulta, confirma ni anula desde el modo contrario: sigue pendiente y reservada', async (mode) => {
    const m = merchantId();
    await fundAvailable(mode, m, 2000);
    const h = await hold(mode, holdBody(m, 600));
    expect(h.status).toBe(201);
    const otherMode = other(mode);
    expect((await ctx.as('pay-settlement', otherMode).get(`/holds/${h.body.id}`)).status).toBe(404);
    expect(checked(ctx, 'POST', `/holds/${h.body.id}/post`, await ctx.as('pay-settlement', otherMode).post(`/holds/${h.body.id}/post`).set('idempotency-key', key())).status).toBe(404);
    expect(checked(ctx, 'POST', `/holds/${h.body.id}/void`, await ctx.as('pay-settlement', otherMode).post(`/holds/${h.body.id}/void`).set('idempotency-key', key())).status).toBe(404);
    expect(checked(ctx, 'GET', `/holds/${h.body.id}`, await ctx.as('pay-settlement', mode).get(`/holds/${h.body.id}`)).body.status).toBe('pending');
    const bal = (await balance(mode, `merchant:${m}:available`)).body;
    expect(bal).toMatchObject({ balance_minor: 1400, pending_debits_minor: 600 }) // el saldo ya descuenta lo retenido;
  });

  it('la misma Idempotency-Key usada en el otro modo NO repite la respuesta guardada del primero', async () => {
    const m = merchantId();
    await fundAvailable('test', m, 1000);
    await fundAvailable('live', m, 1000);
    const th = await hold('test', holdBody(m, 100));
    const lh = await hold('live', holdBody(m, 100));
    const sharedKey = key();
    const a = await ctx.as('pay-settlement', 'test').post(`/holds/${th.body.id}/void`).set('idempotency-key', sharedKey);
    const b = await ctx.as('pay-settlement', 'live').post(`/holds/${lh.body.id}/void`).set('idempotency-key', sharedKey);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.id).toBe(th.body.id);
    expect(b.body.id).toBe(lh.body.id); // cada modo con su propia respuesta
    expect(b.header['idempotency-replayed']).toBeUndefined();
  });

  it('el rechazo por saldo de un modo no consume el intento del otro y queda registrado con su modo', async () => {
    const m = merchantId();
    const ref = businessRef('payout');
    await fundAvailable('live', m, 500);
    const rejected = await tx('test', body(ref, 1, [leg(`merchant:${m}:available`, 'payout:clearing', 400, 'payout')]), 'pay-settlement');
    expect(rejected.status).toBe(422);
    const okLive = await tx('live', body(ref, 1, [leg(`merchant:${m}:available`, 'payout:clearing', 400, 'payout')]), 'pay-settlement');
    expect(okLive.status).toBe(201); // mismo business_ref y attempt 1: en live no estaba rechazado
    const rows = await ctx.db.pool.query('SELECT mode FROM ledger_rejections WHERE business_ref = $1', [ref]);
    expect(rows.rows).toEqual([{ mode: 'test' }]);
  });

  it('concurrencia: 10 cobros simultáneos en cada modo sobre la misma cuenta lógica suman por separado', async () => {
    const m = merchantId();
    const calls = MODES.flatMap((mode) => Array.from({ length: 10 }, (_, i) => tx(mode, body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, (mode === 'test' ? 10 : 7) + i - i)]))));
    const results = await Promise.all(calls);
    expect(results.map((r) => [r.status, r.body.code])).toEqual(results.map(() => [201, undefined]));
    expect((await balance('test', `merchant:${m}:pending`)).body.balance_minor).toBe(100);
    expect((await balance('live', `merchant:${m}:pending`)).body.balance_minor).toBe(70);
  });

  it('las cuentas de plataforma compartidas por nombre (platform:fees) son distintas en TigerBeetle por modo', async () => {
    const [t, l] = await ctx.engine.lookupAccounts([accountTbId('platform:fees', 'test'), accountTbId('platform:fees', 'live')]);
    expect(accountTbId('platform:fees', 'test')).not.toBe(accountTbId('platform:fees', 'live'));
    // Una de las dos (o las dos) existe tras las pruebas de arriba; nunca son la misma cuenta.
    expect(t?.id === l?.id && t !== undefined).toBe(false);
  });
});

describe('inválido: sin un modo válido NO se atiende, NO se asienta nada y NO se cae en `live`', () => {
  const m = merchantId();
  const BAD: [string, string | null][] = [
    ['sin la cabecera', null],
    ['vacío', ''],
    ['en mayúsculas', 'TEST'],
    ['sandbox (modo de despliegue, no de clave)', 'sandbox'],
    ['un valor cualquiera', 'prod'],
    ['dos modos', 'test,live'],
  ];

  it.each(BAD)('POST /transactions %s ⇒ 403 forbidden y no deja filas ni mueve dinero', async (_name, mode) => {
    const ref = businessRef();
    const before = await count('SELECT count(*) AS n FROM ledger_transactions');
    const res = await ctx.as('pay-payments', mode).post('/transactions', body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 100)])).set('idempotency-key', key());
    checked(ctx, 'POST', '/transactions', res);
    expect([res.status, res.body.code]).toEqual([403, 'forbidden']);
    expect(await count('SELECT count(*) AS n FROM ledger_transactions')).toBe(before);
    expect(await count('SELECT count(*) AS n FROM ledger_accounts WHERE account = $1', [`merchant:${m}:pending`])).toBe(0);
  });

  it.each(BAD)('POST /holds %s ⇒ 403 y no deja filas', async (_name, mode) => {
    const res = await ctx.as('pay-settlement', mode).post('/holds', holdBody(m, 100)).set('idempotency-key', key());
    checked(ctx, 'POST', '/holds', res);
    expect(res.status).toBe(403);
    expect(await count('SELECT count(*) AS n FROM ledger_holds WHERE debit_account = $1', [`merchant:${m}:available`])).toBe(0);
  });

  it.each(BAD)('las lecturas y la resolución de retenciones %s ⇒ 403 en cada ruta', async (_name, mode) => {
    const calls: [string, string, () => import('supertest').Test][] = [
      ['GET', '/transactions/{business_ref}', () => ctx.as('pay-payments', mode).get(`/transactions/${encodeURIComponent(businessRef())}`)],
      ['GET', '/holds/{id}', () => ctx.as('pay-settlement', mode).get('/holds/hd_aaaaaaaaaaaa')],
      ['POST', '/holds/{id}/post', () => ctx.as('pay-settlement', mode).post('/holds/hd_aaaaaaaaaaaa/post').set('idempotency-key', key())],
      ['POST', '/holds/{id}/void', () => ctx.as('pay-settlement', mode).post('/holds/hd_aaaaaaaaaaaa/void').set('idempotency-key', key())],
      ['GET', '/balances', () => ctx.as('pay-settlement', mode).get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`)],
      ['GET', '/statements', () => ctx.as('pay-settlement', mode).get(`/statements?account=${encodeURIComponent(`merchant:${m}:pending`)}`)],
    ];
    for (const [method, template, call] of calls) {
      const res = await call();
      checked(ctx, method, template.replace('{business_ref}', 'x').replace('{id}', 'hd_aaaaaaaaaaaa'), res);
      expect([method, template, res.status, res.body.code]).toEqual([method, template, 403, 'forbidden']);
    }
  });

  it.each(BAD)('GET /balance público %s ⇒ 403', async (_name, mode) => {
    const res = await ctx.as('pay-edge', mode).get('/balance').set('x-merchant-id', m);
    expect([res.status, res.body.code]).toEqual([403, 'forbidden']);
  });

  it('el modo solo sale de la cabecera: un `mode` en el cuerpo o en la consulta se rechaza como campo desconocido y no cambia de modo', async () => {
    const ref = businessRef();
    const viaBody = await ctx.as('pay-payments', 'test').post('/transactions', { ...body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 100)]), mode: 'live' }).set('idempotency-key', key());
    expect([viaBody.status, viaBody.body.code]).toEqual([422, 'validation_failed']);
    const viaQuery = await ctx.as('pay-settlement', 'test').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}&mode=live`);
    expect(viaQuery.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM ledger_transactions WHERE business_ref = $1', [ref])).toBe(0);
  });

  it('el almacenamiento también lo impide: un modo fuera de test|live no entra a ninguna tabla y una pata no puede nombrar una cuenta de otro modo', async () => {
    const pool = ctx.db.pool;
    await expect(pool.query("INSERT INTO ledger_accounts (mode, account, kind, tb_id) VALUES ('prod', 'platform:fees', 'platform_fees', 'a'::char(32))")).rejects.toThrow(/check/i);
    const m2 = merchantId();
    await fundAvailable('live', m2, 100);
    // La cuenta existe solo en live: una pata de `test` que la nombre viola la clave foránea compuesta (mode, account).
    await expect(
      pool.query(
        `INSERT INTO ledger_legs (id, mode, source, source_id, business_ref, attempt, leg_index, debit_account, credit_account, amount_minor, code)
         VALUES ('tf_cruzado', 'test', 'transaction', 'tx_cruzado', 'x', 1, 0, $1, 'payout:clearing', 1, 'payout')`,
        [`merchant:${m2}:available`],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
