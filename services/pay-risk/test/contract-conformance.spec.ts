import $RefParser from '@apidevtools/json-schema-ref-parser';
import request from 'supertest';
import { bearer } from './doubles/operator-auth.double';
import { CONTRACT_RISK, createTestContext, type TestContext } from './support/app';
import { assessmentBody, bo, post, rows, verified } from './support/http';

/**
 * Conformidad con `contracts/openapi/internal-risk-v1.yaml` (ola 2): el servicio implementa TODAS las operaciones y TODOS los campos del
 * contrato vigente, y lo que el contrato declara válido no se rechaza.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

type Schema = { properties?: Record<string, unknown> };
async function contractDoc() {
  return (await $RefParser.dereference(CONTRACT_RISK)) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, Schema> } };
}

describe('conformidad con internal-risk-v1.yaml', () => {
  it('las operaciones del contrato son exactamente las rutas montadas (/assessments, /assessments/{id}, /rule_sets, /rule_sets/current)', async () => {
    const doc = await contractDoc();
    const declared = Object.entries(doc.paths).flatMap(([path, item]) => Object.keys(item).filter((m) => ['get', 'post', 'put', 'delete', 'patch'].includes(m)).map((m) => `${m.toUpperCase()} ${path}`)).sort();
    const instance = ctx.app.getHttpAdapter().getInstance() as { router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }; _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } };
    const mounted = (instance.router ?? instance._router)?.stack
      .filter((l) => l.route && !String(l.route.path).includes('*') && !String(l.route.path).startsWith('/health'))
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${String(l.route!.path).replace(/:([A-Za-z]+)/g, '{$1}')}`))
      .sort();
    expect(declared).toEqual(['GET /assessments/{id}', 'GET /rule_sets/current', 'POST /assessments', 'POST /rule_sets']);
    expect(mounted).toEqual(declared);
  });

  it('un pedido con TODOS los campos del esquema `AssessmentCreate` vigente (screening.name + entity_type del pagador) cumple el contrato y se acepta; sin el nombre del comercio (D-29) queda en review', async () => {
    const doc = await contractDoc();
    const top = Object.keys(doc.components.schemas.AssessmentCreate.properties ?? {}).sort();
    const screening = Object.keys((doc.components.schemas.AssessmentCreate.properties?.screening as Schema).properties ?? {}).sort();
    const body: Record<string, unknown> = { ...assessmentBody({ payer_fingerprint: 'huella-conformidad', screening: null }), screening: { name: 'Nombre Sintético Conformidad', entity_type: 'business' } };
    expect(Object.keys(body).sort()).toEqual(top);
    expect(Object.keys(body.screening as object).sort()).toEqual(screening);
    expect(ctx.contract.validateRequest({ method: 'post', path: '/assessments', body })).toEqual([]);
    const created = verified(ctx.contract, 'post', '/assessments', await post(ctx, body), 201);
    expect(created).toMatchObject({ object: 'risk_assessment', payment_intent_id: body.payment_intent_id, decision: 'review', reason_code: 'screening_not_provided', screened: false });
    // La respuesta trae todos los campos que el esquema `Assessment` declara.
    expect(Object.keys(created).sort()).toEqual(Object.keys(doc.components.schemas.Assessment.properties ?? {}).sort());
  });

  it('D-29: lo ÚNICO que el servicio acepta de más que el contrato vigente es el nombre legal del comercio (merchant_name, merchant_entity_type; PR-17)', async () => {
    const doc = await contractDoc();
    const contractFields = Object.keys((doc.components.schemas.AssessmentCreate.properties?.screening as Schema).properties ?? {});
    const body = assessmentBody({ screening: { merchant_entity_type: 'business' } });
    const accepted = Object.keys(body.screening as object).filter((k) => !contractFields.includes(k)).sort();
    expect(accepted).toEqual(['merchant_entity_type', 'merchant_name']);
    const res = await post(ctx, body);
    expect(res.status).toBe(201);
    // Un campo que no es ni del contrato ni de la extensión sigue rechazado.
    expect((await post(ctx, assessmentBody({ screening: { dob: '1980-01-01' } as never }))).status).toBe(422);
  });

  it('un pedido con TODOS los campos de `RuleSetCreate` cumple el contrato, se acepta y la respuesta trae todos los de `RuleSet`', async () => {
    const doc = await contractDoc();
    const body = {
      effective_from: new Date(ctx.clock.now.getTime() + 1000).toISOString(),
      max_amount_minor: 1_000_000,
      merchant_daily_amount_minor: 5_000_000,
      payer_daily_amount_minor: 2_000_000,
      payer_velocity: { max: 5, window_seconds: 3600 },
      merchant_velocity: { max: 500, window_seconds: 3600 },
      hours: { from: 6, to: 22 },
    };
    expect(Object.keys(body).sort()).toEqual(Object.keys(doc.components.schemas.RuleSetCreate.properties ?? {}).sort());
    expect(ctx.contract.validateRequest({ method: 'post', path: '/rule_sets', body })).toEqual([]);
    const res = await bo(ctx, 'post', '/rule_sets').send(body);
    const created = verified(ctx.contract, 'post', '/rule_sets', res, 201);
    expect(Object.keys(created).sort()).toEqual(Object.keys(doc.components.schemas.RuleSet.properties ?? {}).sort());
    expect(created).toMatchObject({ max_amount_minor: 1_000_000, payer_velocity: { max: 5, window_seconds: 3600 }, hours: { from: 6, to: 22 } });
    const current = verified(ctx.contract, 'get', '/rule_sets/current', await bo(ctx, 'get', '/rule_sets/current'), 200);
    expect(current.version).toBe(1); // la vigencia es futura: todavía rige la v1 «sin límites»
  });

  it('todo `reason_code` documentado en el contrato es alcanzable y el servicio no emite ninguno fuera de él', async () => {
    const doc = await contractDoc();
    const description = (doc.components.schemas.Assessment.properties?.reason_code as { description: string }).description;
    const documented = [...description.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1]).filter((c) => !['allow', 'deny', 'review'].includes(c));
    const emitted = new Set((await rows(ctx, 'SELECT DISTINCT reason_code FROM risk_assessments')).map((r) => r.reason_code as string));
    for (const code of emitted) expect({ code, documented: documented.includes(code) }).toEqual({ code, documented: true });
    expect(documented).toEqual(expect.arrayContaining(['ok', 'no_limits_configured', 'sanctions_match', 'amount_over_limit', 'daily_limit_exceeded', 'payer_daily_limit_exceeded', 'velocity_exceeded', 'merchant_velocity_exceeded', 'sanctions_possible_match', 'screening_unavailable', 'screening_not_provided', 'payer_unidentified', 'outside_allowed_hours']));
  });

  it('el `503` queda reservado: ningún camino lo devuelve (Watchman caído ⇒ 201 `review`)', async () => {
    const down = await createTestContext({ settings: { watchmanUrl: 'http://127.0.0.1:1' } });
    try {
      const res = await post(down, assessmentBody());
      expect([res.status, res.body.decision, res.body.reason_code]).toEqual([201, 'review', 'screening_unavailable']);
    } finally {
      await down.close();
    }
  });

  it('las operaciones de back-office exigen `X-Service-Id: pay-backoffice` y rol `risk_admin` (x-required-role del contrato)', async () => {
    for (const [method, path] of [['post', '/rule_sets'], ['get', '/rule_sets/current']] as const) {
      const call = (service: string | undefined, auth: string | undefined) => {
        const req = request(ctx.server)[method](path);
        if (service) req.set('x-service-id', service);
        if (auth) req.set('authorization', auth);
        return method === 'post' ? req.send({}) : req;
      };
      expect((await call(undefined, bearer('op-risk'))).status).toBe(403);
      expect((await call('pay-payments', bearer('op-risk'))).status).toBe(403);
      expect((await call('pay-backoffice', undefined)).status).toBe(401);
      expect((await call('pay-backoffice', bearer('op-other'))).status).toBe(403);
    }
  });
});
