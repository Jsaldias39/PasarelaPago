import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId } from './helpers/app';

/**
 * Gate «Idempotencia» (PLAN-MAESTRO §7): cada mutación repetida N veces EN PARALELO tiene un solo efecto. Complementa las pruebas que ya
 * existen (`transactions.spec`: 10 transferencias idénticas con claves distintas; `holds.spec`: 5 confirmaciones con claves distintas):
 * acá se repite la MISMA `Idempotency-Key` (el reintento real de un cliente) y se cubren las mutaciones que faltaban —crear, confirmar y
 * anular retención, contracargo—, además de la transferencia con la misma clave. El efecto se mide en TigerBeetle (saldo) y en Postgres (filas).
 */
let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const N = 10;
const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code = 'charge') => ({ debit_account, credit_account, amount_minor, code });
const post = async (path: string, payload: object | undefined, idempotencyKey: string, caller = 'pay-settlement') =>
  checked(ctx, 'POST', path, await ctx.as(caller).post(path, payload).set('idempotency-key', idempotencyKey));
/**
 * Una duplicada que llega MIENTRAS la primera sigue ejecutándose recibe `409 idempotency_request_in_progress` (@pay/idempotency): es la señal de
 * «reintentá», no un segundo efecto. Por eso, en una ráfaga, cada respuesta es de éxito (de las permitidas) o ese 409 exacto, y al menos una es de éxito.
 */
function expectOnlyInFlightConflicts(results: { status: number; body: { code?: string } }[], success: number[]) {
  const inFlight = results.filter((r) => r.status === 409);
  for (const r of inFlight) expect(r.body.code).toBe('idempotency_request_in_progress');
  expect(results.filter((r) => success.includes(r.status)).length + inFlight.length).toBe(results.length);
  expect(results.some((r) => success.includes(r.status))).toBe(true);
}
/** La repetición sale de la tabla de idempotencia (jsonb, que reordena las claves): se compara por contenido, no por orden. */
const canon = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const done = <T extends { status: number }>(results: T[]) => results.filter((r) => r.status !== 409);
const repeat = <T>(fn: () => Promise<T>) => Promise.all(Array.from({ length: N }, fn));
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);
const balance = async (account: string) => {
  const res = checked(ctx, 'GET', '/balances', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(account)}`));
  return res.status === 404 ? 0 : (res.body as { balance_minor: number }).balance_minor;
};
async function fund(m: string, amount: number) {
  expect((await post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, amount)] }, key(), 'pay-payments')).status).toBe(201);
  expect((await post('/transactions', { business_ref: businessRef('release'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')] }, key())).status).toBe(201);
}
const holdBody = (m: string, amount: number) => ({
  business_ref: businessRef('payout'),
  attempt: 1,
  debit_account: `merchant:${m}:available`,
  credit_account: 'payout:clearing',
  amount_minor: amount,
  currency: 'BOB',
  expires_in_seconds: 60,
});

describe(`mutaciones repetidas ${N} veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto`, () => {
  it('POST /transactions: una 201 y nueve 200 con el mismo cuerpo; una fila y un solo movimiento', async () => {
    const m = merchantId();
    const ref = businessRef();
    const payload = { business_ref: ref, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 5000)] };
    const k = key();
    const results = await repeat(() => post('/transactions', payload, k, 'pay-payments'));
    expectOnlyInFlightConflicts(results, [200, 201]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(done(results).map((r) => r.body.id)).size).toBe(1);
    const retry = await post('/transactions', payload, k, 'pay-payments'); // el reintento tras la ráfaga: misma transacción, sin mover dinero
    expect(retry).toMatchObject({ status: 200, body: { id: done(results)[0].body.id, result: 'exists' } });
    expect(await balance(`merchant:${m}:pending`)).toBe(5000);
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE business_ref = $1', [ref])).toBe(1);
  });

  it('POST /holds: una sola retención; el disponible baja una vez', async () => {
    const m = merchantId();
    await fund(m, 3000);
    const payload = holdBody(m, 1000);
    const k = key();
    const results = await repeat(() => post('/holds', payload, k));
    expectOnlyInFlightConflicts(results, [200, 201]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(done(results).map((r) => r.body.id)).size).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM ledger_holds WHERE business_ref = $1', [payload.business_ref])).toBe(1);
    expect(await balance(`merchant:${m}:available`)).toBe(2000);
  });

  it('POST /holds/{id}/post: una sola confirmación; el dinero llega a payout:clearing una vez', async () => {
    const m = merchantId();
    await fund(m, 2500);
    const hold = await post('/holds', holdBody(m, 2500), key());
    const before = await balance('payout:clearing');
    const k = key();
    const results = await repeat(() => post(`/holds/${hold.body.id}/post`, undefined, k));
    expectOnlyInFlightConflicts(results, [200]);
    expect(new Set(done(results).map((r) => canon(r.body))).size).toBe(1);
    expect((await post(`/holds/${hold.body.id}/post`, undefined, k)).headers['idempotency-replayed']).toBe('true');
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE source_id = $1', [hold.body.id])).toBe(1);
    expect((await balance('payout:clearing')) - before).toBe(2500);
    expect(await balance(`merchant:${m}:available`)).toBe(0);
  });

  it('POST /holds/{id}/void: una sola anulación; el monto vuelve una vez y no se cobra', async () => {
    const m = merchantId();
    await fund(m, 1800);
    const hold = await post('/holds', holdBody(m, 1800), key());
    expect(await balance(`merchant:${m}:available`)).toBe(0);
    const k = key();
    const results = await repeat(() => post(`/holds/${hold.body.id}/void`, undefined, k));
    expectOnlyInFlightConflicts(results, [200]);
    expect(new Set(done(results).map((r) => canon(r.body))).size).toBe(1);
    expect(await balance(`merchant:${m}:available`)).toBe(1800);
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE source_id = $1', [hold.body.id])).toBe(0);
  });

  it('contracargo (transferencia con débito a `pending` mayor que lo pendiente): mismo business_ref y clave ⇒ se aplica una vez, con la deuda que corresponde', async () => {
    const m = merchantId();
    expect((await post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 100)] }, key(), 'pay-payments')).status).toBe(201);
    const ref = businessRef('dispute');
    const payload = { business_ref: ref, attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, CLEARING, 150, 'adjustment')] };
    const k = key();
    const results = await repeat(() => post('/transactions', payload, k, 'pay-payments'));
    expectOnlyInFlightConflicts(results, [200, 201]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balance(`merchant:${m}:pending`)).toBe(0);
    expect(await balance(`merchant:${m}:debt`)).toBe(50); // 150 − 100 pendientes: la deuda no se duplica
    expect(await count('SELECT count(*)::int AS n FROM ledger_transactions WHERE business_ref = $1', [ref])).toBe(1);
  });

  it('control: con claves DISTINTAS y la misma operación de negocio, sigue habiendo un solo efecto (idempotencia por business_ref + attempt, no solo por cabecera)', async () => {
    const m = merchantId();
    const ref = businessRef();
    const payload = { business_ref: ref, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 700)] };
    const results = await repeat(() => post('/transactions', payload, key(), 'pay-payments'));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balance(`merchant:${m}:pending`)).toBe(700);
  });
});
