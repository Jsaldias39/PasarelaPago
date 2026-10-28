import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId } from './helpers/app';
import { accountTbId, holdMeta, holdTbId } from './helpers/ids';
import { pendingTransfer } from '../src/ledger/tb-engine';
import { waitFor } from './helpers/wait';

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code: string) => ({ debit_account, credit_account, amount_minor, code });

async function tx(legs: object[], caller: string) {
  const res = await ctx.as(caller).post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs }).set('idempotency-key', key());
  expect(res.status).toBe(201);
}
/** Deja `amount` disponibles en el comercio. */
async function fund(m: string, amount: number) {
  await tx([leg(CLEARING, `merchant:${m}:pending`, amount, 'charge')], 'pay-payments');
  await tx([leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')], 'pay-settlement');
}
const holdBody = (m: string, amount: number, over: object = {}) => ({
  business_ref: businessRef('payout'),
  attempt: 1,
  debit_account: `merchant:${m}:available`,
  credit_account: 'payout:clearing',
  amount_minor: amount,
  currency: 'BOB',
  expires_in_seconds: 60,
  ...over,
});
async function createHold(payload: object, caller = 'pay-settlement') {
  return checked(ctx, 'POST', '/holds', await ctx.as(caller).post('/holds', payload).set('idempotency-key', key()));
}
async function resolve(id: string, action: 'post' | 'void', body?: object, idemKey = key(), caller = 'pay-settlement') {
  const path = `/holds/${id}/${action}`;
  return checked(ctx, 'POST', path, await ctx.as(caller).post(path, body).set('idempotency-key', idemKey));
}
async function balance(account: string) {
  const res = checked(ctx, 'GET', '/balances', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(account)}`));
  return res.body as { balance_minor: number; pending_debits_minor: number };
}
const getHold = async (id: string) => checked(ctx, 'GET', `/holds/${id}`, await ctx.as('pay-settlement').get(`/holds/${id}`));
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;

describe('POST /holds — primera fase', () => {
  it('reserva el monto: el disponible baja y NO se puede gastar dos veces lo retenido', async () => {
    const m = merchantId();
    await fund(m, 10_000);
    const hold = await createHold(holdBody(m, 4000));
    expect(hold.status).toBe(201);
    expect(hold.body).toMatchObject({ object: 'hold', result: 'created', status: 'pending', amount_minor: 4000, posted_amount_minor: null });
    const b = await balance(`merchant:${m}:available`);
    expect(b.balance_minor).toBe(6000);
    expect(b.pending_debits_minor).toBe(4000);
    const doubleSpend = await createHold(holdBody(m, 6001));
    expect(doubleSpend.status).toBe(422);
    expect(doubleSpend.body.code).toBe('insufficient_funds');
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(6000);
    expect((await createHold(holdBody(m, 6000))).status).toBe(201); // lo que queda sí se puede retener
  });

  it('idempotente por (business_ref, attempt) y con la regla de intentos', async () => {
    const m = merchantId();
    const payload = holdBody(m, 1000);
    const rejected = await createHold(payload); // sin saldo
    expect(rejected.status).toBe(422);
    await fund(m, 1000);
    expect((await createHold(payload)).status).toBe(422); // el attempt 1 sigue siendo el rechazo
    expect((await createHold({ ...payload, attempt: 3 })).status).toBe(409);
    const ok = await createHold({ ...payload, attempt: 2 });
    expect(ok.status).toBe(201);
    const again = await createHold({ ...payload, attempt: 2 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ result: 'exists', id: ok.body.id });
    expect((await createHold({ ...payload, attempt: 2, amount_minor: 999 })).body.code).toBe('idempotency_key_reused');
    expect((await createHold({ ...payload, attempt: 4 })).status).toBe(409);
    expect((await rows('SELECT count(*)::int AS n FROM ledger_rejections WHERE business_ref = $1', [payload.business_ref]))[0].n).toBe(1);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(0);
  });

  it('valida la entrada y los permisos', async () => {
    const m = merchantId();
    for (const bad of [holdBody(m, 0), holdBody(m, 10, { expires_in_seconds: 0 }), holdBody(m, 10, { extra: 1 }), holdBody(m, 10, { credit_account: `merchant:${m}:available` })]) {
      const res = await createHold(bad);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
    const forbidden = await createHold(holdBody(m, 10), 'pay-payments'); // pay-payments no toca payout:clearing
    expect(forbidden.status).toBe(403);
  });
});

describe('POST /holds/{id}/post y /void — segunda fase', () => {
  it('post total: mueve el monto, deja pata y extracto, y publica los eventos', async () => {
    const m = merchantId();
    await fund(m, 10_000);
    const hold = await createHold(holdBody(m, 4000));
    const posted = await resolve(hold.body.id, 'post');
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ status: 'posted', posted_amount_minor: 4000 });
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(6000);
    const legs = await rows('SELECT code, amount_minor, source FROM ledger_legs WHERE source_id = $1', [hold.body.id]);
    expect(legs).toEqual([{ code: 'payout', amount_minor: '4000', source: 'hold' }]);
    const events = await rows("SELECT type FROM outbox_events WHERE aggregate_id = $1 OR envelope->>'subject' = $1 ORDER BY seq", [hold.body.id]);
    expect(events.map((e) => e.type)).toEqual(['ledger.hold.created', 'ledger.hold.posted']);
  });

  it('post parcial: lo no confirmado vuelve a la cuenta de origen', async () => {
    const m = merchantId();
    await fund(m, 5000);
    const hold = await createHold(holdBody(m, 3000));
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(2000);
    const posted = await resolve(hold.body.id, 'post', { amount_minor: 1000 });
    expect(posted.body).toMatchObject({ status: 'posted', posted_amount_minor: 1000, amount_minor: 3000 });
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(4000); // 5000 − 1000 confirmados
  });

  it('post por más de lo retenido ⇒ 422 y la retención sigue pendiente', async () => {
    const m = merchantId();
    await fund(m, 2000);
    const hold = await createHold(holdBody(m, 500));
    const res = await resolve(hold.body.id, 'post', { amount_minor: 501 });
    expect(res.status).toBe(422);
    expect((await getHold(hold.body.id)).body.status).toBe('pending');
  });

  it('void devuelve el monto y publica ledger.hold.voided', async () => {
    const m = merchantId();
    await fund(m, 2000);
    const hold = await createHold(holdBody(m, 2000));
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(0);
    const voided = await resolve(hold.body.id, 'void');
    expect(voided.body).toMatchObject({ status: 'voided', posted_amount_minor: null });
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(2000);
    expect((await rows("SELECT envelope->'data'->>'reason' AS reason FROM outbox_events WHERE type = 'ledger.hold.voided' AND aggregate_id = $1", [hold.body.id]))[0].reason).toBe('requested');
  });

  it('se resuelve UNA sola vez: post o void de una retención ya resuelta ⇒ 409', async () => {
    const m = merchantId();
    await fund(m, 3000);
    const hold = await createHold(holdBody(m, 1000));
    expect((await resolve(hold.body.id, 'post')).status).toBe(200);
    for (const action of ['post', 'void'] as const) {
      const res = await resolve(hold.body.id, action);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('invalid_state_transition');
    }
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(2000);
  });

  it('con la misma Idempotency-Key se repite la respuesta guardada, incluso un error de negocio', async () => {
    const m = merchantId();
    await fund(m, 1000);
    const hold = await createHold(holdBody(m, 1000));
    const k = key();
    const first = await resolve(hold.body.id, 'post', undefined, k);
    const replay = await resolve(hold.body.id, 'post', undefined, k);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const k2 = key();
    const conflict = await resolve(hold.body.id, 'void', undefined, k2);
    expect(conflict.status).toBe(409);
    const conflictAgain = await resolve(hold.body.id, 'void', undefined, k2);
    expect(conflictAgain.status).toBe(409);
    expect(conflictAgain.headers['idempotency-replayed']).toBe('true');
  });

  it('5 confirmaciones simultáneas con claves distintas ⇒ UNA efectiva y cuatro 409; el dinero se mueve una vez', async () => {
    const m = merchantId();
    await fund(m, 3000);
    const hold = await createHold(holdBody(m, 3000));
    const results = await Promise.all(Array.from({ length: 5 }, () => resolve(hold.body.id, 'post')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await rows('SELECT count(*)::int AS n FROM ledger_legs WHERE source_id = $1', [hold.body.id]))[0].n).toBe(1);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(0);
  });

  it('id inexistente o con una forma que ninguna retención puede tener ⇒ 404', async () => {
    expect((await resolve('hd_aaaaaaaaaaaa', 'post')).status).toBe(404);
    expect((await getHold('hd_aaaaaaaaaaaa')).status).toBe(404);
    expect((await resolve('no-es-un-id', 'void')).status).toBe(404);
    expect((await getHold('no-es-un-id')).status).toBe(404);
  });
});

describe('vencimiento de una retención (REQ-P2-3)', () => {
  it('pasado el plazo sin resolver, el monto vuelve solo; no se puede confirmar; el barrido deja constancia y publica el evento', async () => {
    const m = merchantId();
    await fund(m, 2500);
    const hold = await createHold(holdBody(m, 2500, { expires_in_seconds: 1 }));
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(0);

    // TigerBeetle vence la retención por su cuenta y devuelve el monto (se espera por condición, no por tiempo fijo)
    const restored = await waitFor(async () => ((await balance(`merchant:${m}:available`)).balance_minor === 2500 ? true : false), 15_000, 250);
    expect(restored).toBe(true);

    expect((await getHold(hold.body.id)).body.status).toBe('expired'); // lectura: vencida aunque el barrido aún no la marcó
    const late = await resolve(hold.body.id, 'post');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('invalid_state_transition');

    const swept = await ctx.holds.sweepExpired(0, new Date(Date.now() + 5000));
    expect(swept).toBeLessThanOrEqual(1);
    const row = (await rows('SELECT status, resolved_at FROM ledger_holds WHERE id = $1', [hold.body.id]))[0];
    expect(row.status).toBe('expired');
    expect(row.resolved_at).not.toBeNull();
    const expiredEvents = await rows("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'ledger.hold.expired' AND aggregate_id = $1", [hold.body.id]);
    expect(expiredEvents[0].n).toBe(1);
    expect(await ctx.holds.sweepExpired(0, new Date(Date.now() + 5000))).toBe(0); // idempotente
    expect((await rows("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'ledger.hold.expired' AND aggregate_id = $1", [hold.body.id]))[0].n).toBe(1);
    expect((await balance(`merchant:${m}:available`)).balance_minor).toBe(2500);
  });
});

describe('POST /holds — reutilizar (business_ref, attempt) con otro contenido tras una caída', () => {
  it('TigerBeetle ya tiene esa retención con OTRO monto: 422 idempotency_key_reused, nada se registra ni se mueve (antes: 500)', async () => {
    const m = merchantId();
    await fund(m, 1_000);
    const payload = holdBody(m, 100);
    // el servicio murió después de aplicar una retención de 700 con el mismo (business_ref, attempt)
    await ctx.engine.createTransfers([
      pendingTransfer({ id: holdTbId(payload.business_ref, 1), debit: accountTbId(`merchant:${m}:available`), credit: accountTbId('payout:clearing'), amount: 700n, code: 'payout', meta: holdMeta(payload.business_ref, 1) }, 60),
    ]);
    const res = await createHold(payload);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('idempotency_key_reused');
    expect(Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM ledger_holds WHERE business_ref = $1', [payload.business_ref])).rows[0].n)).toBe(0);
  });
});
