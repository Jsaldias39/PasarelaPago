import { ProblemError } from '@pay/problem';
import { accountTbId, legTbId } from '../src/ledger/ids';
import { TigerBeetleEngine, plainTransfer } from '../src/ledger/tb-engine';
import { loadLedgerConfig } from '../src/ledger/ledger.config';
import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId } from './helpers/app';

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code = 'charge') => ({ debit_account, credit_account, amount_minor, code });
const body = (ref: string, attempt: number, legs: object[]) => ({ business_ref: ref, attempt, currency: 'BOB', legs });

/** `idemKey: null` = no mandar la cabecera (un `undefined` activaría el valor por defecto). */
async function createTx(payload: object, caller = 'pay-payments', idemKey: string | null = key()) {
  let req = ctx.as(caller).post('/transactions', payload);
  if (idemKey !== null) req = req.set('idempotency-key', idemKey);
  return checked(ctx, 'POST', '/transactions', await req);
}
async function balance(account: string) {
  const res = checked(ctx, 'GET', '/balances', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(account)}`));
  return res.body as { balance_minor: number; nature: string };
}
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

/** Deja `amount` disponibles en el comercio: cobro (clearing → pending) y liberación (pending → available). */
async function fundAvailable(m: string, amount: number) {
  const ref = businessRef('capture');
  expect((await createTx(body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, amount)]))).status).toBe(201);
  const rel = await createTx(body(businessRef('release'), 1, [leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')]), 'pay-settlement');
  expect(rel.status).toBe(201);
}

describe('POST /transactions — el cobro de referencia del plan (D-07, D-20)', () => {
  it('Bs 100,00 con 2,5 % + Bs 0,50 deja 97,00 al comercio y 3,00 a la plataforma, con débitos = créditos', async () => {
    const m = merchantId();
    const tbNet = async () => {
      const [a] = await ctx.engine.lookupAccounts([accountTbId('platform:fees')]);
      return a ? Number(a.credits_posted - a.debits_posted) : 0;
    };
    const feesBefore = await tbNet(); // platform:fees es compartida por todas las corridas: se mide la diferencia
    const ref = businessRef();
    const res = await createTx(body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 9700), leg(CLEARING, 'platform:fees', 300, 'fee')]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'transaction', result: 'created', status: 'posted', business_ref: ref, attempt: 1, currency: 'BOB', reject_code: null });
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(9700);
    expect((await tbNet()) - feesBefore).toBe(300);
    const clearing = await balance(CLEARING);
    expect(clearing.nature).toBe('debit');
  });
});

describe('POST /transactions — idempotencia (REQ-P2-1)', () => {
  it('repetir el mismo asiento devuelve `exists` con el mismo id y no mueve dinero otra vez', async () => {
    const m = merchantId();
    const payload = body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, 1234)]);
    const first = await createTx(payload);
    const again = await createTx(payload, 'pay-payments', key()); // otra Idempotency-Key: la idempotencia real es (business_ref, attempt)
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.result).toBe('exists');
    expect(again.body.id).toBe(first.body.id);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(1234);
  });

  it('10 llamadas simultáneas idénticas ⇒ UNA sola efectiva (una 201 y nueve 200)', async () => {
    const m = merchantId();
    const ref = businessRef();
    const payload = body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 5000)]);
    const results = await Promise.all(Array.from({ length: 10 }, () => createTx(payload)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(5000);
    expect(await count('SELECT count(*)::int AS n FROM ledger_transactions WHERE business_ref = $1', [ref])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE business_ref = $1', [ref])).toBe(1);
  });

  it('el mismo (business_ref, attempt) con OTRO contenido ⇒ 422 idempotency_key_reused y no mueve dinero', async () => {
    const m = merchantId();
    const ref = businessRef();
    await createTx(body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 1000)]));
    const res = await createTx(body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 2000)]));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('idempotency_key_reused');
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(1000);
  });
});

describe('POST /transactions — regla de intentos que hace cumplir el servidor (H-TB1)', () => {
  it('tras un rechazo, `attempt`+1 se acepta; un attempt nuevo tras un intento ACEPTADO es 409 y no mueve dinero', async () => {
    const m = merchantId();
    const ref = businessRef('payout');
    const available = `merchant:${m}:available`;
    const debit = [leg(available, 'payout:clearing', 7000, 'payout')];

    // attempt 1: sin saldo ⇒ rechazado
    const rejected = await createTx(body(ref, 1, debit), 'pay-settlement');
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('insufficient_funds');

    // repetir el attempt 1 devuelve el MISMO rechazo (idempotente), aunque ahora haya saldo
    await fundAvailable(m, 7000);
    const replay = await createTx(body(ref, 1, debit), 'pay-settlement');
    expect(replay.status).toBe(422);
    expect(replay.body.code).toBe('insufficient_funds');

    // saltarse el 2 ⇒ 409
    const skipped = await createTx(body(ref, 3, debit), 'pay-settlement');
    expect(skipped.status).toBe(409);
    expect(skipped.body.code).toBe('invalid_state_transition');

    // attempt 2 ⇒ aceptado
    const accepted = await createTx(body(ref, 2, debit), 'pay-settlement');
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ attempt: 2, status: 'posted' });
    expect((await balance(available)).balance_minor).toBe(0);

    // con un intento aceptado, ningún attempt nuevo mueve dinero otra vez
    for (const attempt of [3, 4]) {
      const again = await createTx(body(ref, attempt, debit), 'pay-settlement');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('invalid_state_transition');
    }
    expect((await balance('payout:clearing')).nature).toBe('credit');
    // el attempt 2 repetido sigue siendo idempotente
    expect((await createTx(body(ref, 2, debit), 'pay-settlement')).body.result).toBe('exists');

    // GET: los dos intentos, del más nuevo al más viejo, con el rechazado a la vista
    const got = checked(ctx, 'GET', `/transactions/${ref}`, await ctx.as('pay-settlement').get(`/transactions/${encodeURIComponent(ref)}`));
    expect(got.status).toBe(200);
    expect(got.body.attempts.map((a: { attempt: number; status: string }) => [a.attempt, a.status])).toEqual([[2, 'posted'], [1, 'rejected']]);
  });

  it('el primer attempt tiene que ser 1: empezar en 2 es 409', async () => {
    const m = merchantId();
    const res = await createTx(body(businessRef(), 2, [leg(CLEARING, `merchant:${m}:pending`, 100)]));
    expect(res.status).toBe(409);
    expect(await count('SELECT count(*)::int AS n FROM ledger_transactions')).toBeGreaterThanOrEqual(0);
    expect((await ctx.as('pay-payments').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`)).status).toBe(404);
  });
});

describe('POST /transactions — atomicidad y saldo (REQ-P2-2, M8)', () => {
  it('un lote con una pata sin saldo no aplica NINGUNA (lote enlazado)', async () => {
    const m = merchantId();
    const res = await createTx(body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, 800), leg(`merchant:${m}:available`, 'platform:fees', 100, 'fee')]), 'pay-settlement');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_funds');
    expect((await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`)).body.balance_minor ?? 0).toBe(0); // la cuenta se creó, pero la primera pata no se aplicó
  });

  it('saldo justo ⇒ aceptado; un centavo más ⇒ 422 y el saldo no cambia', async () => {
    const m = merchantId();
    await fundAvailable(m, 5000);
    const over = await createTx(body(businessRef('payout'), 1, [leg(`merchant:${m}:available`, 'payout:clearing', 5001, 'payout')]), 'pay-settlement');
    expect(over.status).toBe(422);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(5000);
    const exact = await createTx(body(businessRef('payout'), 1, [leg(`merchant:${m}:available`, 'payout:clearing', 5000, 'payout')]), 'pay-settlement');
    expect(exact.status).toBe(201);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(0);
  });

  it('medio «saldo AloVida»: la billetera paga a un comercio; sin saldo, rechazo sin efecto', async () => {
    const m = merchantId();
    const wallet = `user:usr_${merchantId().slice(3)}:wallet`;
    // recarga sintética de la billetera
    expect((await createTx(body(businessRef('topup'), 1, [leg(CLEARING, wallet, 3000, 'wallet_transfer')]))).status).toBe(201);
    const poor = await createTx(body(businessRef('wallet'), 1, [leg(wallet, `merchant:${m}:pending`, 3001, 'wallet_transfer')]));
    expect(poor.status).toBe(422);
    expect((await balance(wallet)).balance_minor).toBe(3000);
    const ok = await createTx(body(businessRef('wallet'), 1, [leg(wallet, `merchant:${m}:pending`, 3000, 'wallet_transfer')]));
    expect(ok.status).toBe(201);
    expect((await balance(wallet)).balance_minor).toBe(0);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(3000);
  });

  it('de `merchant:available` de un comercio a `merchant:pending` de otro (transferencia entre comercios)', async () => {
    const a = merchantId();
    const b = merchantId();
    await fundAvailable(a, 4000);
    const res = await createTx(body(businessRef('wallet'), 1, [leg(`merchant:${a}:available`, `merchant:${b}:pending`, 1500, 'wallet_transfer')]));
    expect(res.status).toBe(201);
    expect((await balance(`merchant:${a}:available`)).balance_minor).toBe(2500);
    expect((await balance(`merchant:${b}:pending`)).balance_minor).toBe(1500);
  });

  it('100 patas en un asiento se aplican; 101 se rechazan por validación', async () => {
    const m = merchantId();
    const legs = Array.from({ length: 100 }, () => leg(CLEARING, `merchant:${m}:pending`, 1));
    expect((await createTx(body(businessRef(), 1, legs))).status).toBe(201);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(100);
    const tooMany = await createTx(body(businessRef(), 1, [...legs, leg(CLEARING, `merchant:${m}:pending`, 1)]));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe('validation_failed');
  });
});

describe('POST /transactions — rastro de rechazos (P2.H1.M9)', () => {
  it('un rechazo deja una fila con business_ref, attempt y motivo; repetirlo no duplica el rastro', async () => {
    const m = merchantId();
    const ref = businessRef('payout');
    const payload = body(ref, 1, [leg(`merchant:${m}:available`, 'payout:clearing', 10, 'payout')]);
    expect((await createTx(payload, 'pay-settlement')).status).toBe(422);
    expect((await createTx(payload, 'pay-settlement')).status).toBe(422);
    const { rows } = await ctx.db.pool.query('SELECT kind, business_ref, attempt, reject_code, tb_status, caller FROM ledger_rejections WHERE business_ref = $1', [ref]);
    expect(rows).toEqual([{ kind: 'transaction', business_ref: ref, attempt: 1, reject_code: 'insufficient_funds', tb_status: 'exceeds_credits', caller: 'pay-settlement' }]);
  });
});

describe('POST /transactions — validación de entrada (lista blanca) y permisos', () => {
  const m = merchantId();
  const okLeg = leg(CLEARING, `merchant:${m}:pending`, 100);

  it.each([
    ['campo no declarado en el cuerpo', { ...body(businessRef(), 1, [okLeg]), hack: true }],
    ['campo no declarado en una pata', body(businessRef(), 1, [{ ...okLeg, extra: 1 }])],
    ['importe 0', body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, 0)])],
    ['importe con decimales', body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, 10.5)])],
    ['importe negativo', body(businessRef(), 1, [leg(CLEARING, `merchant:${m}:pending`, -5)])],
    ['importe como texto', body(businessRef(), 1, [{ ...okLeg, amount_minor: '100' }])],
    ['attempt 0', body(businessRef(), 0, [okLeg])],
    ['moneda distinta de BOB', { ...body(businessRef(), 1, [okLeg]), currency: 'USD' }],
    ['business_ref mal formado', body('cualquier cosa', 1, [okLeg])],
    ['cuenta fuera del plan', body(businessRef(), 1, [leg(CLEARING, 'merchant:x:pending', 100)])],
    ['débito igual a crédito', body(businessRef(), 1, [leg('platform:fees', 'platform:fees', 100)])],
    ['sin patas', body(businessRef(), 1, [])],
    ['código de movimiento inventado', body(businessRef(), 1, [{ ...okLeg, code: 'regalo' }])],
  ])('rechaza %s con 422 validation_failed y no registra nada', async (_name, payload) => {
    const before = await count('SELECT count(*)::int AS n FROM ledger_transactions');
    const res = await createTx(payload);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(await count('SELECT count(*)::int AS n FROM ledger_transactions')).toBe(before);
  });

  it('sin Idempotency-Key ⇒ 400 idempotency_key_required', async () => {
    const res = await createTx(body(businessRef(), 1, [okLeg]), 'pay-payments', null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  it.each([
    ['sin identidad de servicio', undefined, `merchant:${m}:pending`, CLEARING],
    ['un servicio que no puede llamar al ledger', 'pay-edge', `merchant:${m}:pending`, CLEARING],
    ['pay-schedules tocando una cuenta de conector', 'pay-schedules', `merchant:${m}:available`, CLEARING],
    ['pay-payments tocando payout:clearing', 'pay-payments', `merchant:${m}:pending`, 'payout:clearing'],
  ])('403 para %s', async (_name, caller, credit, debit) => {
    const req = caller
      ? ctx.as(caller).post('/transactions', body(businessRef(), 1, [leg(debit, credit, 100)]))
      : (await import('supertest')).default(ctx.baseUrl).post('/transactions').send(body(businessRef(), 1, [leg(debit, credit, 100)]));
    const res = checked(ctx, 'POST', '/transactions', await req.set('idempotency-key', key()));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('GET de un business_ref inexistente ⇒ 404', async () => {
    const res = checked(ctx, 'GET', '/transactions/x', await ctx.as('pay-payments').get(`/transactions/${encodeURIComponent(businessRef())}`));
    expect(res.status).toBe(404);
  });
});

describe('recuperación ante una caída entre TigerBeetle y Postgres (ids deterministas)', () => {
  it('TigerBeetle aplicó pero Postgres no registró: reintentar el mismo attempt NO duplica el dinero', async () => {
    const m = merchantId();
    const ref = businessRef();
    // Se crean las cuentas con otra operación y se aplica a mano la pata, como si el servicio hubiera muerto antes de registrar.
    await createTx(body(businessRef('seed'), 1, [leg(CLEARING, `merchant:${m}:pending`, 1)]));
    const statuses = await ctx.engine.createTransfers([
      plainTransfer({ id: legTbId(ref, 1, 0), debit: accountTbId(CLEARING), credit: accountTbId(`merchant:${m}:pending`), amount: 900n, code: 'charge' }, false),
    ]);
    expect(statuses).toHaveLength(1);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(901);

    const res = await createTx(body(ref, 1, [leg(CLEARING, `merchant:${m}:pending`, 900)]));
    expect(res.status).toBe(201);
    expect((await balance(`merchant:${m}:pending`)).balance_minor).toBe(901); // 1 + 900, no 1 + 1800
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE business_ref = $1', [ref])).toBe(1);
  });

  it('TigerBeetle rechazó pero Postgres no registró: el reintento queda como rechazo (id_already_failed), sin mover dinero', async () => {
    const m = merchantId();
    const ref = businessRef('payout');
    await fundAvailable(m, 100);
    await ctx.engine.createTransfers([
      plainTransfer({ id: legTbId(ref, 1, 0), debit: accountTbId(`merchant:${m}:available`), credit: accountTbId('payout:clearing'), amount: 5000n, code: 'payout' }, false),
    ]);
    const res = await createTx(body(ref, 1, [leg(`merchant:${m}:available`, 'payout:clearing', 50, 'payout')]), 'pay-settlement');
    expect(res.status).toBe(422);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(100);
    const { rows } = await ctx.db.pool.query('SELECT tb_status FROM ledger_rejections WHERE business_ref = $1', [ref]);
    expect(rows[0].tb_status).toBe('id_already_failed');
  });
});

describe('cliente de TigerBeetle (H-4 y H-5)', () => {
  it('un cluster_id equivocado no da error en TigerBeetle: el servicio responde 503 ledger_unavailable dentro de su propio timeout', async () => {
    const config = loadLedgerConfig();
    const wrong = new TigerBeetleEngine({ ...config.tb, clusterId: 777n, timeoutMs: 1500 });
    const started = Date.now();
    await expect(wrong.lookupAccounts([1n])).rejects.toMatchObject({ code: 'ledger_unavailable', status: 503 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(4000);
    await expect(wrong.lookupAccounts([1n])).rejects.toBeInstanceOf(ProblemError);
    wrong.destroy();
  });
});
