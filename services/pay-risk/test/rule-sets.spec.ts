import request from 'supertest';
import { bearer, OPERATORS } from './doubles/operator-auth.double';
import { createTestContext, type TestContext } from './support/app';
import { bo, rows, verified } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const publish = (body: object, as = 'op-risk') => bo(ctx, 'post', '/rule_sets', as).send(body);

describe('conjuntos de reglas versionados: sin límites por defecto (D-23, P5.H2.M2)', () => {
  it('la versión 1 es «sin límites»: todo apagado, y el contrato lo dice con nulls', async () => {
    const current = verified(ctx.ruleSetsContract, 'get', '/rule_sets/current', await bo(ctx, 'get', '/rule_sets/current'), 200);
    expect(current).toEqual({
      object: 'risk_rule_set', version: 1, effective_from: '2000-01-01T00:00:00.000Z', max_amount_minor: null, merchant_daily_amount_minor: null,
      payer_daily_amount_minor: null, payer_velocity: null, merchant_velocity: null, hours: null, published_by: 'system:no-limits',
    });
  });

  it('el esquema no trae ningún valor numérico de límite sembrado: la única fila es la v1 con todo en NULL', async () => {
    const all = await rows(ctx, 'SELECT * FROM risk_rule_sets');
    expect(all).toHaveLength(1);
    const limits = Object.entries(all[0]).filter(([k]) => !['version', 'effective_from', 'published_by', 'created_at'].includes(k));
    expect(limits.every(([, v]) => v === null)).toBe(true);
    // Idempotencia del sembrado: aplicar el SQL otra vez no agrega ni cambia nada.
    const sql = (await import('node:fs')).readFileSync(`${process.cwd()}/sql/ddl.sql`, 'utf8');
    const seed = sql.split('\n').find((l) => l.startsWith('INSERT INTO risk_rule_sets')) as string;
    await ctx.db.pool.query(seed);
    expect(await rows(ctx, 'SELECT 1 FROM risk_rule_sets')).toHaveLength(1);
  });

  it('publicar crea la versión siguiente con quién la publicó (sale de la credencial); un cuerpo vacío publica «sin límites»', async () => {
    const v2 = verified(ctx.ruleSetsContract, 'post', '/rule_sets', await publish({ max_amount_minor: 500_000, payer_velocity: { max: 5, window_seconds: 3600 }, hours: { from: 6, to: 22 } }), 201);
    expect(v2).toMatchObject({ version: 2, max_amount_minor: 500_000, payer_velocity: { max: 5, window_seconds: 3600 }, hours: { from: 6, to: 22 }, merchant_velocity: null, published_by: OPERATORS['op-risk'].sub });
    const v3 = verified(ctx.ruleSetsContract, 'post', '/rule_sets', await publish({}), 201);
    expect(v3).toMatchObject({ version: 3, max_amount_minor: null, payer_velocity: null, hours: null });
    expect((await bo(ctx, 'get', '/rule_sets/current')).body.version).toBe(3);
    // Las anteriores siguen intactas.
    expect((await rows(ctx, 'SELECT max_amount_minor::text AS m FROM risk_rule_sets WHERE version = 2'))[0].m).toBe('500000');
  });

  it('mandar `published_by` o cualquier campo no declarado se rechaza (la autoría no sale del cuerpo)', async () => {
    const res = await publish({ max_amount_minor: 1, published_by: 'otro' });
    expect(res.status).toBe(422);
  });

  it.each([
    ['importe 0', { max_amount_minor: 0 }],
    ['importe negativo', { max_amount_minor: -1 }],
    ['importe decimal', { max_amount_minor: 1.5 }],
    ['importe sobre el máximo seguro', { max_amount_minor: 9007199254740992 }],
    ['velocidad sin ventana', { payer_velocity: { max: 3 } }],
    ['velocidad con tope 0', { payer_velocity: { max: 0, window_seconds: 60 } }],
    ['ventana de 0 segundos', { merchant_velocity: { max: 1, window_seconds: 0 } }],
    ['horario sin fin', { hours: { from: 8 } }],
    ['horario con fin 25', { hours: { from: 8, to: 25 } }],
    ['horario con inicio 24', { hours: { from: 24, to: 24 } }],
    ['horario al revés (no cubre medianoche)', { hours: { from: 20, to: 8 } }],
    ['horario vacío (inicio = fin)', { hours: { from: 8, to: 8 } }],
    ['fecha inválida', { effective_from: 'mañana' }],
  ])('inválido: %s ⇒ 422 y no se escribe la versión', async (_name, body) => {
    const before = (await rows(ctx, 'SELECT count(*)::int AS n FROM risk_rule_sets'))[0].n;
    const res = await publish(body);
    expect(res.status).toBe(422);
    expect((await rows(ctx, 'SELECT count(*)::int AS n FROM risk_rule_sets'))[0].n).toBe(before);
  });

  it('límites válidos en el borde: 1 centavo, tope seguro, horario 0–24, ventana de un año', async () => {
    expect((await publish({ max_amount_minor: 1 })).status).toBe(201);
    expect((await publish({ max_amount_minor: 9007199254740991, merchant_daily_amount_minor: 9007199254740991 })).status).toBe(201);
    expect((await publish({ hours: { from: 0, to: 24 }, payer_velocity: { max: 1000000, window_seconds: 31536000 } })).status).toBe(201);
  });

  it('vigencia: una fecha pasada o anterior a la versión previa se rechaza; una futura no rige hasta que llega', async () => {
    expect((await publish({ effective_from: '2020-01-01T00:00:00Z' })).body.errors).toEqual([{ field: 'effective_from', code: 'in_the_past' }]);
    const future = new Date(ctx.clock.now.getTime() + 7200_000).toISOString();
    const queued = verified(ctx.ruleSetsContract, 'post', '/rule_sets', await publish({ effective_from: future, max_amount_minor: 7 }), 201);
    expect((await bo(ctx, 'get', '/rule_sets/current')).body.version).toBeLessThan(queued.version);
    const between = new Date(ctx.clock.now.getTime() + 3600_000).toISOString();
    expect((await publish({ effective_from: between })).body.errors).toEqual([{ field: 'effective_from', code: 'before_previous_version' }]);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 7201_000);
    expect((await bo(ctx, 'get', '/rule_sets/current')).body.version).toBe(queued.version);
  });

  it('5 publicaciones simultáneas numeran las versiones sin huecos ni repetidos', async () => {
    const before = (await rows(ctx, 'SELECT max(version)::int AS v FROM risk_rule_sets'))[0].v as number;
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => publish({ max_amount_minor: 1000 + i })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.body.version).sort((a, b) => a - b)).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5]);
  });

  it('las versiones son INMUTABLES a nivel de base', async () => {
    await expect(ctx.db.pool.query('UPDATE risk_rule_sets SET max_amount_minor = 5 WHERE version = 2')).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM risk_rule_sets WHERE version = 2')).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('TRUNCATE risk_rule_sets CASCADE')).rejects.toThrow(/inmutable/);
  });
});

describe('autorización de la carga de reglas (matriz negativa)', () => {
  const routes: [string, 'get' | 'post'][] = [['/rule_sets', 'post'], ['/rule_sets/current', 'get']];

  it.each(routes)('%s (%s): sin servicio, con otro servicio, sin token, con token falso, sin rol o con otro rol ⇒ rechazado', async (path, method) => {
    const call = () => request(ctx.server)[method](path);
    const send = async (req: request.Test) => (method === 'post' ? req.send({}) : req);
    expect((await send(call().set('authorization', bearer('op-risk')))).status).toBe(403); // sin x-service-id
    for (const service of ['pay-edge', 'pay-payments', 'pay-risk']) expect({ service, status: (await send(call().set('x-service-id', service).set('authorization', bearer('op-risk')))).status }).toEqual({ service, status: 403 });
    expect((await send(call().set('x-service-id', 'pay-backoffice'))).status).toBe(401);
    expect((await send(call().set('x-service-id', 'pay-backoffice').set('authorization', 'Bearer op-hacker'))).status).toBe(401);
    expect((await send(call().set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-norole')))).status).toBe(403);
    expect((await send(call().set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-other')))).status).toBe(403);
    expect((await send(call().set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-risk')))).status).toBe(method === 'post' ? 201 : 200);
  });

  it('el rol de reglas no abre las evaluaciones, ni al revés (pay-payments no carga límites)', async () => {
    const payments = await request(ctx.server).post('/rule_sets').set('x-service-id', 'pay-payments').send({});
    expect(payments.status).toBe(403);
    const backoffice = await request(ctx.server).post('/assessments').set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-risk')).set('idempotency-key', 'clave-de-prueba-1').send({});
    expect(backoffice.status).toBe(403);
  });

  it('por defecto (sin verificador de operadores configurado) falla cerrado: 401 en toda la carga de reglas', async () => {
    const closed = await createTestContext({ realOperatorAuthenticator: true });
    try {
      for (const [path, method] of routes) {
        const res = await request(closed.server)[method](path).set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-risk')).send({});
        expect({ path, status: res.status }).toEqual({ path, status: 401 });
      }
      expect((await closed.db.pool.query('SELECT count(*)::int AS n FROM risk_rule_sets')).rows[0].n).toBe(1);
    } finally {
      await closed.close();
    }
  });
});
