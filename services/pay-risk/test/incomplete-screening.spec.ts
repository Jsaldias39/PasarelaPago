import { safeIdempotencyKey } from '@pay/idempotency';
import { RISK_SETTINGS, type RiskSettings } from '../src/settings';
import { createTestContext, type TestContext } from './support/app';
import { assessmentBody, CLEAN_MERCHANT_NAME, CLEAN_NAME, post, rows, SANCTIONED_ORG, uniqueKey, verified } from './support/http';
import { entity, json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

/**
 * PRODUCT_BUG hallado por el arnés de P1 (`e2e/pending/risk-timeout.e2e.ts`): un timeout de Watchman daba `review`/`screening_unavailable`, quedaba GUARDADO
 * bajo la Idempotency-Key y un comercio limpio no podía reintentar aunque Watchman se recuperara. Un cribado que no se pudo completar (timeout, caída,
 * respuesta inválida) es un resultado sobre el cribado, NO sobre la persona.
 *
 * Regla: se responde la decisión fail-closed (`review`/`screening_unavailable`, `screened: false`, 201) pero la clave queda libre y un reintento con la
 * MISMA clave y el MISMO cuerpo VUELVE A CRIBAR. Solo una evaluación cribada (o una que no depende del cribado: sin nombre del comercio) queda congelada.
 * Cada intento deja su propio rastro (inmutable). No se tocan contrato ni umbrales.
 */
type Behavior = Parameters<typeof startWatchmanDouble>[0];
const CLEAR: Behavior = (_req, res) => json(res, { entities: null });
const TIMEOUT: Behavior = (_req, res) => void setTimeout(() => json(res, { entities: null }), 700); // más que screeningTimeoutMs (150)
const DOWN: Behavior = (_req, res) => json(res, { error: 'caído' }, 503);
const GARBAGE: Behavior = (_req, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end('{esto no es json');
const WRONG_SHAPE: Behavior = (_req, res) => json(res, { entities: [{ match: 'alto' }] });
const SANCTIONED: Behavior = (req, res) => json(res, { entities: new URL(req.url ?? '/', 'http://x').searchParams.get('name') === SANCTIONED_ORG ? [entity(0.95)] : null });

describe('cribado incompleto con el Watchman [DOBLE]', () => {
  let ctx: TestContext;
  let double: WatchmanDouble;
  beforeAll(async () => {
    double = await startWatchmanDouble(CLEAR);
    ctx = await createTestContext({ settings: { watchmanUrl: double.url, screeningTimeoutMs: 150 } });
  });
  afterAll(async () => {
    await ctx.close();
    await double.close();
  });
  const asked = (): number => double.requests.length;
  const trail = (intent: string) => rows(ctx, `SELECT id, request_key, decision, reason_code, screened FROM risk_assessments WHERE payment_intent_id = $1 ORDER BY created_at, id`, [intent]);
  const keyState = async (key: string) => (await rows(ctx, 'SELECT state FROM idempotency_keys WHERE key = $1', [safeIdempotencyKey(key)]))[0]?.state as string | undefined;

  it('correcto: timeout y luego OK ⇒ el reintento con la MISMA clave vuelve a cribar, da allow y QUEDA definitivo; repetirlo no vuelve a cribar', async () => {
    const key = uniqueKey();
    const body = assessmentBody({});
    double.behavior = TIMEOUT;
    const first = verified(ctx.contract, 'post', '/assessments', await post(ctx, body, key), 201);
    expect(first).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
    expect(await keyState(key)).toBe('started'); // la clave NO se completó: no hay respuesta guardada

    double.behavior = CLEAR;
    const second = await post(ctx, body, key);
    expect({ status: second.status, decision: second.body.decision, screened: second.body.screened }).toEqual({ status: 201, decision: 'allow', screened: true });
    expect(second.body.id).not.toBe(first.id);
    expect(await keyState(key)).toBe('completed');

    const before = asked();
    const third = await post(ctx, body, key);
    expect({ status: third.status, id: third.body.id }).toEqual({ status: 200, id: second.body.id });
    expect(asked()).toBe(before); // una evaluación definitiva NO se vuelve a cribar

    // Auditoría: ambos intentos, sin perder el rastro del fallido; la clave de rastro del fallido es propia.
    const intent = body.payment_intent_id as string;
    const all = await trail(intent);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === first.id)).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
    expect(String(all.find((r) => r.id === first.id)?.request_key)).toMatch(new RegExp(`^${key}~sin-cribar~[0-9a-f]{8}$`));
    expect(all.find((r) => r.id === second.body.id)).toMatchObject({ request_key: key, decision: 'allow', screened: true });
    expect((await post(ctx, body, key)).status).toBe(200);
  });

  it.each([
    ['caída persistente (503)', DOWN],
    ['respuesta que no es JSON', GARBAGE],
    ['respuesta con forma inesperada', WRONG_SHAPE],
    ['timeout persistente', TIMEOUT],
  ])('límite: %s ⇒ review/screening_unavailable CADA vez, nunca allow, cada intento con su rastro; al recuperarse el cribado, la MISMA clave converge', async (_name, behavior) => {
    const key = uniqueKey();
    const body = assessmentBody({});
    double.behavior = behavior;
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const res = await post(ctx, body, key);
      expect({ status: res.status, decision: res.body.decision, reason: res.body.reason_code, screened: res.body.screened }).toEqual({ status: 201, decision: 'review', reason: 'screening_unavailable', screened: false });
      ids.add(res.body.id as string);
    }
    expect(ids.size).toBe(3);
    expect((await trail(body.payment_intent_id as string)).filter((r) => r.decision === 'review' && r.screened === false)).toHaveLength(3);
    expect(await keyState(key)).toBe('started');
    double.behavior = CLEAR;
    const recovered = await post(ctx, body, key);
    expect({ status: recovered.status, decision: recovered.body.decision, screened: recovered.body.screened }).toEqual({ status: 201, decision: 'allow', screened: true });
    expect((await trail(body.payment_intent_id as string)).filter((r) => r.request_key === key)).toHaveLength(1);
  });

  it('límite: una coincidencia fuerte del pagador manda aunque el cribado del comercio falle ⇒ deny DEFINITIVO (es un resultado sobre la persona) y no se vuelve a cribar', async () => {
    const key = uniqueKey();
    const body = assessmentBody({ screening: { merchant_name: CLEAN_MERCHANT_NAME, name: SANCTIONED_ORG, entity_type: 'business' } });
    double.behavior = (req, res) => (new URL(req.url ?? '/', 'http://x').searchParams.get('name') === SANCTIONED_ORG ? SANCTIONED(req, res, null) : DOWN(req, res, null));
    const first = await post(ctx, body, key);
    expect({ status: first.status, decision: first.body.decision, reason: first.body.reason_code }).toEqual({ status: 201, decision: 'deny', reason: 'sanctions_match' });
    const before = asked();
    const again = await post(ctx, body, key);
    expect({ status: again.status, id: again.body.id }).toEqual({ status: 200, id: first.body.id });
    expect(asked()).toBe(before);
  });

  it('límite: sin nombre del comercio no hay nada que cribar ⇒ `screening_not_provided` es una decisión sobre la petición y queda congelada (el cribado no se intenta)', async () => {
    double.behavior = CLEAR;
    const key = uniqueKey();
    const body = assessmentBody({ screening: { merchant_name: undefined, name: undefined, entity_type: undefined } });
    const first = await post(ctx, body, key);
    expect({ status: first.status, reason: first.body.reason_code, screened: first.body.screened }).toEqual({ status: 201, reason: 'screening_not_provided', screened: false });
    const before = asked();
    const again = await post(ctx, body, key);
    expect({ status: again.status, id: again.body.id }).toEqual({ status: 200, id: first.body.id });
    expect(asked()).toBe(before);
  });

  it('inválido: el cuerpo distinto con la misma clave sigue siendo 422 (idempotency_key_reused) aunque el primer intento no fuera definitivo; 5 simultáneas con el cribado caído ⇒ 201 o 409, nunca allow ni 5xx', async () => {
    const key = uniqueKey();
    const body = assessmentBody({});
    double.behavior = DOWN;
    expect((await post(ctx, body, key)).status).toBe(201);
    const other = await post(ctx, { ...body, amount_minor: 99_999 }, key);
    expect({ status: other.status, code: other.body.code }).toEqual({ status: 422, code: 'idempotency_key_reused' });
    const racing = await Promise.all(Array.from({ length: 5 }, () => post(ctx, body, key)));
    for (const res of racing) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 201) expect({ decision: res.body.decision, reason: res.body.reason_code }).toEqual({ decision: 'review', reason: 'screening_unavailable' });
    }
    double.behavior = CLEAR;
    expect((await post(ctx, body, key)).body.decision).toBe('allow');
  });

  it('el nombre del comercio y del pagador no quedan en el rastro del intento fallido ni en la clave de rastro', async () => {
    double.behavior = DOWN;
    const key = uniqueKey();
    const body = assessmentBody({ screening: { merchant_name: CLEAN_MERCHANT_NAME, name: CLEAN_NAME, entity_type: 'business' } });
    await post(ctx, body, key);
    const dump = JSON.stringify(await rows(ctx, 'SELECT * FROM risk_assessments WHERE payment_intent_id = $1', [body.payment_intent_id]));
    expect(dump).not.toContain(CLEAN_MERCHANT_NAME);
    expect(dump).not.toContain(CLEAN_NAME);
    expect(ctx.logs.join('\n')).not.toContain(CLEAN_MERCHANT_NAME);
  });
});

describe('cribado incompleto con el Watchman REAL (listas estáticas de 2019, solo sandbox)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ settings: { screeningTimeoutMs: 1 } }); // 1 ms: el Watchman real no llega a responder ⇒ `unavailable`
  });
  afterAll(async () => ctx.close());
  const timeout = (ms: number): void => void ((ctx.app.get(RISK_SETTINGS) as { screeningTimeoutMs: RiskSettings['screeningTimeoutMs'] }).screeningTimeoutMs = ms);

  it('correcto: un comercio limpio que chocó con un timeout real reintenta con la MISMA clave y, al responder Watchman, da allow definitivo', async () => {
    const key = uniqueKey();
    const body = assessmentBody({});
    const first = await post(ctx, body, key);
    expect({ status: first.status, decision: first.body.decision, reason: first.body.reason_code, screened: first.body.screened }).toEqual({ status: 201, decision: 'review', reason: 'screening_unavailable', screened: false });
    timeout(5000);
    const second = await post(ctx, body, key);
    expect({ status: second.status, decision: second.body.decision, screened: second.body.screened }).toEqual({ status: 201, decision: 'allow', screened: true });
    expect((await post(ctx, body, key)).status).toBe(200);
    timeout(1);
  });

  it('límite: un nombre sancionado que chocó con un timeout NO se cuela: el reintento con Watchman respondiendo es deny/sanctions_match definitivo', async () => {
    const key = uniqueKey();
    const body = assessmentBody({ screening: { merchant_name: SANCTIONED_ORG, entity_type: undefined } });
    const first = await post(ctx, body, key);
    expect(first.body).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
    timeout(5000);
    const second = await post(ctx, body, key);
    expect({ status: second.status, decision: second.body.decision, reason: second.body.reason_code }).toEqual({ status: 201, decision: 'deny', reason: 'sanctions_match' });
    expect((await post(ctx, body, key)).body.id).toBe(second.body.id);
    timeout(1);
  });
});
