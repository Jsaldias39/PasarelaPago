import { combineScreenings } from '../src/screening/combine';
import type { ScreeningResult } from '../src/screening/screener';
import { createTestContext, type TestContext } from './support/app';
import { assessmentBody, CLEAN_MERCHANT_NAME, CLEAN_NAME, post, rows, SANCTIONED_ORG, SANCTIONED_ORG_TYPO, uniqueKey, verified } from './support/http';
import { entity, json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

const part = (party: 'merchant' | 'payer', result: ScreeningResult) => ({ party, result });

describe('combineScreenings (D-29): el resultado del cobro es el más grave de comercio y pagador', () => {
  it('orden de gravedad: match > unavailable > possible_match > clear, sea cual sea la parte', () => {
    const clear: ScreeningResult = { outcome: 'clear' };
    const possible: ScreeningResult = { outcome: 'possible_match', topScore: 0.7, list: 'us_ofac', sourceId: '1' };
    const unavailable: ScreeningResult = { outcome: 'unavailable' };
    const match: ScreeningResult = { outcome: 'match', topScore: 0.9, list: 'us_ofac', sourceId: '2' };
    for (const [a, b, expected] of [[clear, clear, 'clear'], [clear, possible, 'possible_match'], [possible, unavailable, 'unavailable'], [unavailable, match, 'match'], [clear, match, 'match'], [possible, possible, 'possible_match']] as const) {
      expect({ a: a.outcome, b: b.outcome, ab: combineScreenings([part('merchant', a), part('payer', b)]).outcome }).toEqual({ a: a.outcome, b: b.outcome, ab: expected });
      expect(combineScreenings([part('merchant', b), part('payer', a)]).outcome).toBe(expected);
    }
  });

  it('el detalle y la parte son los de la coincidencia de mayor puntaje; sin puntajes, la parte del peor resultado', () => {
    const r = combineScreenings([part('merchant', { outcome: 'possible_match', topScore: 0.65, list: 'us_ofac', sourceId: '10' }), part('payer', { outcome: 'match', topScore: 0.95, list: 'us_ofac', sourceId: '20' })]);
    expect(r).toEqual({ outcome: 'match', party: 'payer', topScore: 0.95, list: 'us_ofac', sourceId: '20' });
    expect(combineScreenings([part('merchant', { outcome: 'clear' })])).toEqual({ outcome: 'clear', party: 'merchant' });
    expect(combineScreenings([part('merchant', { outcome: 'clear' }), part('payer', { outcome: 'unavailable' })]).party).toBe('payer');
  });

  it('inválido: nada que combinar lanza', () => {
    expect(() => combineScreenings([])).toThrow(RangeError);
  });
});

describe('D-29 con el Watchman REAL: se criba siempre el nombre legal del comercio y, si el pagador dio nombre, también', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());
  const ask = async (overrides: Parameters<typeof assessmentBody>[0]) => verified(ctx.contract, 'post', '/assessments', await post(ctx, assessmentBody(overrides)), 201);
  const party = async (id: string) => (await rows(ctx, 'SELECT screening_party, screening_top_score FROM risk_assessments WHERE id = $1', [id]))[0];

  it('correcto: comercio y pagador limpios ⇒ allow cribado', async () => {
    expect(await ask({})).toMatchObject({ decision: 'allow', reason_code: 'no_limits_configured', screened: true });
  });

  it('PAGADOR INVITADO sin nombre no bloquea: con el comercio limpio es allow cribado', async () => {
    expect(await ask({ screening: { name: undefined } })).toMatchObject({ decision: 'allow', screened: true });
  });

  it('el COMERCIO en una lista ⇒ deny, y el rastro dice que fue el comercio (sin guardar su nombre)', async () => {
    const body = await ask({ screening: { merchant_name: SANCTIONED_ORG } });
    expect(body).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
    expect(await party(body.id)).toMatchObject({ screening_party: 'merchant' });
  });

  it('el PAGADOR en una lista ⇒ deny aunque el comercio esté limpio, y el rastro dice que fue el pagador', async () => {
    const body = await ask({ screening: { name: SANCTIONED_ORG } });
    expect(body).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match' });
    expect(await party(body.id)).toMatchObject({ screening_party: 'payer' });
  });

  it('coincidencia aproximada de cualquiera ⇒ review', async () => {
    expect(await ask({ screening: { merchant_name: SANCTIONED_ORG_TYPO } })).toMatchObject({ decision: 'review', reason_code: 'sanctions_possible_match' });
    expect(await ask({ screening: { name: SANCTIONED_ORG_TYPO } })).toMatchObject({ decision: 'review', reason_code: 'sanctions_possible_match' });
  });

  it('SIN nombre del comercio ⇒ review `screening_not_provided` (es lo que siempre debe venir), aunque el pagador esté limpio o no tenga nombre', async () => {
    for (const screening of [{ merchant_name: undefined }, { merchant_name: undefined, name: undefined }]) {
      expect(await ask({ screening })).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
    }
    expect(await ask({ screening: null })).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
  });

  it('sin nombre del comercio pero con el PAGADOR en una lista ⇒ deny (una coincidencia fuerte no se esconde detrás del review)', async () => {
    expect(await ask({ screening: { merchant_name: undefined, name: SANCTIONED_ORG } })).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
  });

  it('el tipo del comercio por defecto es empresa; se puede declarar persona', async () => {
    expect(await ask({ screening: { merchant_name: CLEAN_MERCHANT_NAME, merchant_entity_type: 'person' } })).toMatchObject({ decision: 'allow', screened: true });
  });

  it('idempotencia: cambiar SOLO el nombre del comercio con la misma clave es otro pedido (422)', async () => {
    const body = assessmentBody();
    const key = uniqueKey();
    expect((await post(ctx, body, key)).status).toBe(201);
    const other = { ...body, screening: { ...(body.screening as object), merchant_name: 'Otro Comercio Sintetico SRL' } };
    const res = await post(ctx, other, key);
    expect([res.status, res.body.code]).toEqual([422, 'idempotency_key_reused']);
  });

  it('privacidad: ni el nombre del comercio ni el del pagador aparecen en el rastro, la idempotencia, las respuestas ni los logs', async () => {
    const m = 'CENTINELA-COMERCIO-D29-LEGAL';
    const p = 'CENTINELA-PAGADOR-D29';
    const body = await ask({ screening: { merchant_name: m, name: p } });
    const dump = [
      ...(await rows(ctx, 'SELECT row_to_json(t)::text AS j FROM risk_assessments t')).map((r) => r.j),
      ...(await rows(ctx, 'SELECT row_to_json(t)::text AS j FROM idempotency_keys t')).map((r) => r.j),
      JSON.stringify(body),
      ctx.logs.join('\n'),
    ].join('\n');
    expect(dump).not.toContain('CENTINELA');
  });
});

describe('[DOBLE] de Watchman: qué se le manda y qué pasa si una de las dos búsquedas falla', () => {
  let double: WatchmanDouble;
  let ctx: TestContext;
  beforeAll(async () => {
    double = await startWatchmanDouble((_req, res) => json(res, { entities: null }));
    ctx = await createTestContext({ settings: { watchmanUrl: double.url } });
  });
  afterAll(async () => {
    await ctx.close();
    await double.close();
  });
  beforeEach(() => {
    double.requests.length = 0;
    double.behavior = (_req, res) => json(res, { entities: null });
  });

  it('con comercio y pagador con tipo: exactamente DOS búsquedas (una por parte), solo con nombre, tipo, umbral y límite', async () => {
    await post(ctx, assessmentBody({ screening: { entity_type: 'person' } }));
    expect(double.requests.map((r) => [r.params.name, r.params.type]).sort()).toEqual([[CLEAN_MERCHANT_NAME, 'business'], [CLEAN_NAME, 'person']].sort());
    for (const r of double.requests) expect(Object.keys(r.params).sort()).toEqual(['limit', 'minMatch', 'name', 'type']);
  });

  it('pagador invitado sin nombre: UNA sola búsqueda (la del comercio)', async () => {
    await post(ctx, assessmentBody({ screening: { name: undefined } }));
    expect(double.requests).toHaveLength(1);
    expect(double.requests[0].params).toMatchObject({ name: CLEAN_MERCHANT_NAME, type: 'business' });
  });

  it('el cribado del pagador no se puede hacer pero el comercio está limpio ⇒ review `screening_unavailable` (no se afirma que está limpio)', async () => {
    double.behavior = (_req, res) => {
      const name = new URL(_req.url ?? '/', 'http://x').searchParams.get('name');
      if (name === CLEAN_NAME) return json(res, {}, 500);
      return json(res, { entities: null });
    };
    expect(await verified(ctx.contract, 'post', '/assessments', await post(ctx, assessmentBody()), 201)).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
  });

  it('pagador con coincidencia fuerte y comercio sin cribar ⇒ deny (lo fuerte manda)', async () => {
    double.behavior = (req, res) => {
      const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name');
      return name === CLEAN_NAME ? json(res, { entities: [entity(0.95)] }) : json(res, {}, 503);
    };
    expect(await verified(ctx.contract, 'post', '/assessments', await post(ctx, assessmentBody()), 201)).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match' });
  });
});
