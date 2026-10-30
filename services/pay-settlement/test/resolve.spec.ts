import { type SettlementTestContext, checked, createSettlementContext, key, merchantId, operatorToken } from './helpers/app';
import { ref } from './helpers/scenarios';

let ctx: SettlementTestContext;
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

/** Una excepción abierta de verdad, creada por una corrida de conciliación. */
async function openException(): Promise<string> {
  const m = merchantId();
  const r = ref();
  ctx.ledger.seedCharge({ merchant: m, net: 1000, fee: 0, at: new Date('2026-10-21T14:30:00Z'), ref: r });
  ctx.connectors.statements.set('mock', { format: 'json', lines: [{ provider_reference: 'B1', our_reference: r, direction: 'credit', amount_minor: 900, value_date: '2026-10-21', booked_at: '2026-10-21T14:30:00.000Z' }] });
  const started = await ctx.as('pay-backoffice').post('/reconciliation_runs', { connector: 'mock', period_from: '2026-10-19T04:00:00.000Z', period_to: '2026-10-26T04:00:00.000Z' }).set('idempotency-key', key());
  expect(started.status).toBe(202);
  await ctx.reconciliation.idle();
  const { body } = await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=open');
  return body.data[0].id as string;
}
const resolve = (id: string, body: object, auth: string | undefined, idem = key(), caller = 'pay-backoffice') => {
  const req = ctx.as(caller).post(`/reconciliation_exceptions/${id}/resolve`, body).set('idempotency-key', idem);
  return auth === undefined ? req : req.set('authorization', auth);
};
const bearer = (roles: string[], sub = 'op_maria01') => `Bearer ${operatorToken(roles, { sub })}`;
const DISMISS = { resolution: 'dismiss', note: 'Falsa alarma: el banco corrigió la línea' };
const ADJUST = { resolution: 'request_adjustment', note: 'Corresponde un ajuste de 100 centavos' };
const ledgerWrites = () => ['createTransaction', 'createHold', 'postHold', 'voidHold'].reduce((n, op) => n + ctx.ledger.count(op), 0);
const audit = async () => (await ctx.db.pool.query('SELECT actor, role, action, subject FROM settlement_audit ORDER BY id')).rows;

describe('resolver una excepción (REQ-P2-6: lo decide una persona)', () => {
  it('dismiss: lo decide `settlement_operator`; quién decide sale de la credencial y queda en la auditoría', async () => {
    const id = await openException();
    const res = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, DISMISS, bearer(['settlement_operator'], 'op_maria01')));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'dismissed', resolved_by: 'op_maria01', resolution_note: DISMISS.note });
    expect(await audit()).toEqual([{ actor: 'op_maria01', role: 'settlement_operator', action: 'reconciliation_exception.dismiss', subject: id }]);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_adjustment_requests')).rows[0].n).toBe(0);
    expect(ledgerWrites()).toBe(0);
  });

  it('request_adjustment: exige `settlement_admin`, deja un pedido y NO toca el ledger', async () => {
    const id = await openException();
    const res = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, ADJUST, bearer(['settlement_admin'], 'op_carla02')));
    expect(res.body).toMatchObject({ status: 'resolved', resolved_by: 'op_carla02' });
    expect((await ctx.db.pool.query('SELECT exception_id, requested_by, difference_minor, status FROM settlement_adjustment_requests')).rows).toEqual([{ exception_id: id, requested_by: 'op_carla02', difference_minor: '-100', status: 'requested' }]);
    expect(await audit()).toEqual([{ actor: 'op_carla02', role: 'settlement_admin', action: 'reconciliation_exception.request_adjustment', subject: id }]);
    expect(ledgerWrites()).toBe(0);
  });

  it('un operador no puede pedir un ajuste (403) y la excepción sigue abierta; un admin sí puede descartar (supuesto: admin incluye operador)', async () => {
    const id = await openException();
    const denied = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, ADJUST, bearer(['settlement_operator'])));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');
    expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=open')).body.data).toHaveLength(1);
    expect((await resolve(id, DISMISS, bearer(['settlement_admin']))).status).toBe(200);
  });

  it('el cuerpo NO decide quién resuelve: un resolved_by escrito a mano es 422 y no cambia nada', async () => {
    const id = await openException();
    const res = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, { ...DISMISS, resolved_by: 'op_jefe' }, bearer(['settlement_operator'], 'op_maria01')));
    expect(res.status).toBe(422);
    expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=open')).body.data).toHaveLength(1);
    expect(await audit()).toEqual([]);
  });

  describe('sin credencial válida: 401 sin decir por qué, y nada cambia (CONTRATOS.md §3 fila 17: 401 la credencial, 403 el rol)', () => {
    it.each([
      ['sin Authorization', () => undefined],
      ['token vencido', () => `Bearer ${operatorToken(['settlement_admin'], { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } })}`],
      ['audiencia ajena', () => `Bearer ${operatorToken(['settlement_admin'], { claims: { aud: 'otro' } })}`],
      ['emisor ajeno', () => `Bearer ${operatorToken(['settlement_admin'], { claims: { iss: 'https://otro.test' } })}`],
      ['alg none', () => `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'op', roles: ['settlement_admin'] })).toString('base64url')}.`],
      ['basura', () => 'Bearer x.y.z'],
      ['solo el service id, sin persona', () => undefined],
    ])('%s', async (_n, make) => {
      const id = await openException();
      const res = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, DISMISS, make()));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(JSON.stringify(res.body)).not.toMatch(/token|expir|firma|signature|audience/i);
      expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=open')).body.data).toHaveLength(1);
      expect(await audit()).toEqual([]);
    });

    it('un servicio que no es la consola, aunque traiga una credencial de admin válida, recibe 403', async () => {
      const id = await openException();
      expect((await resolve(id, DISMISS, bearer(['settlement_admin']), key(), 'pay-schedules')).status).toBe(403);
      expect((await resolve(id, DISMISS, bearer(['settlement_admin']), key(), 'pay-edge')).status).toBe(403);
    });
  });

  it('estados: ya cerrada ⇒ 409 (no se pisa la decisión de otra persona); inexistente o mal formada ⇒ 404', async () => {
    const id = await openException();
    await resolve(id, DISMISS, bearer(['settlement_operator'], 'op_maria01'));
    const again = checked(ctx, 'POST', `/reconciliation_exceptions/${id}/resolve`, await resolve(id, ADJUST, bearer(['settlement_admin'], 'op_carla02')));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_state_transition');
    expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=dismissed')).body.data[0].resolved_by).toBe('op_maria01');
    expect(checked(ctx, 'POST', '/reconciliation_exceptions/rx_abcdefghijklmn/resolve', await resolve('rx_abcdefghijklmn', DISMISS, bearer(['settlement_admin']))).status).toBe(404);
    expect((await resolve('no-es-un-id', DISMISS, bearer(['settlement_admin']))).status).toBe(404);
  });

  it('dos personas resuelven a la vez: una gana (200) y la otra recibe 409; una sola fila de auditoría', async () => {
    const id = await openException();
    const results = await Promise.all([
      resolve(id, DISMISS, bearer(['settlement_operator'], 'op_ana')),
      resolve(id, DISMISS, bearer(['settlement_operator'], 'op_beto')),
      resolve(id, ADJUST, bearer(['settlement_admin'], 'op_carla')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await audit()).toHaveLength(1);
  });

  it('idempotencia: la misma clave repite la respuesta sin duplicar auditoría; el 403 por rol NO se guarda', async () => {
    const id = await openException();
    const idem = key();
    const denied = await resolve(id, ADJUST, bearer(['settlement_operator'], 'op_maria01'), idem);
    expect(denied.status).toBe(403);
    // mismo operador y misma clave, ahora con rol de admin: el 403 anterior no se repite
    const ok = await resolve(id, ADJUST, bearer(['settlement_admin'], 'op_maria01'), idem);
    expect(ok.status).toBe(200);
    const replay = await resolve(id, ADJUST, bearer(['settlement_admin'], 'op_maria01'), idem);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(await audit()).toHaveLength(1);
    expect((await resolve(id, DISMISS, bearer(['settlement_admin'], 'op_maria01'), idem)).body.code).toBe('idempotency_key_reused');
    const noKey = await ctx.as('pay-backoffice').post(`/reconciliation_exceptions/${id}/resolve`, DISMISS).set('authorization', bearer(['settlement_admin']));
    expect(noKey.status).toBe(400);
  });

  it('el motivo es obligatorio y acotado: vacío, ausente o de más de 500 caracteres ⇒ 422', async () => {
    const id = await openException();
    for (const note of ['', undefined, 'x'.repeat(501)]) expect((await resolve(id, { resolution: 'dismiss', note }, bearer(['settlement_operator']))).status).toBe(422);
    expect((await resolve(id, { resolution: 'dismiss', note: 'x'.repeat(500) }, bearer(['settlement_operator']))).status).toBe(200);
  });

  it('una resolución desconocida es 422', async () => {
    const id = await openException();
    expect((await resolve(id, { resolution: 'borrar', note: 'x' }, bearer(['settlement_admin']))).status).toBe(422);
  });
});
