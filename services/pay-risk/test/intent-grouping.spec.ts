import { createTestContext, type TestContext } from './support/app';
import { assessmentBody, newIntent, newMerchant, post, publishRules, rows, SANCTIONED_ORG, uniqueKey } from './support/http';
import { json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

/**
 * PROP-19 de P3: `pay-payments` evalúa UN mismo intento dos veces (comercio y pagador; claves `${intentId}:risk` y `${intentId}:risk:payer`).
 * Regla de pay-risk: el GRUPO es el `payment_intent_id`. Un intento cuenta UNA vez en velocidad (por pagador y por comercio) y en los
 * límites diarios (por pagador y por comercio), con el MAYOR importe que se le evaluó, y no cuenta en los importes si cualquiera de
 * sus evaluaciones fue `deny`. La clave de idempotencia solo sirve para repetir una respuesta, no para agrupar.
 * Se usa un Watchman [DOBLE] que no cribe nada salvo lo que cada prueba pida, para no depender de la carga del Watchman real.
 */
let double: WatchmanDouble;
let ctx: TestContext;
beforeAll(async () => {
  double = await startWatchmanDouble((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name');
    return json(res, { entities: name === SANCTIONED_ORG ? [{ name: 'X', entityType: 'business', sourceList: 'us_ofac', sourceID: '1', match: 0.95 }] : null });
  });
  ctx = await createTestContext({ settings: { watchmanUrl: double.url } });
});
afterAll(async () => {
  await ctx.close();
  await double.close();
});

const day = () => (ctx.clock.now = new Date(ctx.clock.now.getTime() + 25 * 3600_000));
const count = async (intent: string) => Number((await rows(ctx, 'SELECT count(*)::int AS n FROM risk_assessments WHERE payment_intent_id = $1', [intent]))[0].n);

/** Las dos evaluaciones que hace P3 por intento: misma moneda/importe/comercio/pagador, claves distintas. */
async function evaluateTwice(intent: string, base: Record<string, unknown>, second: Record<string, unknown> = {}) {
  const first = await post(ctx, { ...base, payment_intent_id: intent }, `${intent}:risk`);
  const payer = await post(ctx, { ...base, payment_intent_id: intent, ...second }, `${intent}:risk:payer`);
  expect([first.status, payer.status]).toEqual([201, 201]);
  return [first.body, payer.body] as const;
}

describe('un intento evaluado dos veces cuenta UNA vez (PROP-19)', () => {
  describe('velocidad', () => {
    it('correcto: pagador con tope 3 y tres intentos evaluados dos veces cada uno ⇒ los tres pasan y el cuarto se rechaza', async () => {
      await publishRules(ctx, { payer_velocity: { max: 3, window_seconds: 600 } });
      const merchant_id = newMerchant();
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const base = () => assessmentBody({ merchant_id, payer_fingerprint });
      for (let i = 0; i < 3; i += 1) {
        const intent = newIntent();
        const [a, b] = await evaluateTwice(intent, base());
        expect([a.decision, b.decision]).toEqual(['allow', 'allow']);
        expect(await count(intent)).toBe(2);
      }
      const fourth = await post(ctx, base());
      expect(fourth.body).toMatchObject({ decision: 'deny', reason_code: 'velocity_exceeded' });
    });

    it('límite: la SEGUNDA evaluación del intento que alcanzó el tope da la misma decisión que la primera (no se cuenta a sí mismo)', async () => {
      await publishRules(ctx, { merchant_velocity: { max: 2, window_seconds: 600 } });
      const merchant_id = newMerchant();
      const base = () => assessmentBody({ merchant_id });
      await evaluateTwice(newIntent(), base());
      const [a, b] = await evaluateTwice(newIntent(), base()); // el segundo intento: 1 previo < 2 ⇒ pasa, dos veces
      expect([a.decision, b.decision]).toEqual(['allow', 'allow']);
      const [c, d] = await evaluateTwice(newIntent(), base()); // el tercero: 2 previos ⇒ se rechaza, dos veces
      expect([c.decision, d.decision]).toEqual(['deny', 'deny']);
      expect([c.reason_code, d.reason_code]).toEqual(['merchant_velocity_exceeded', 'merchant_velocity_exceeded']);
    });

    it('inválido: 5 evaluaciones simultáneas del MISMO intento con claves distintas cuentan una vez y no se rechazan entre sí', async () => {
      await publishRules(ctx, { payer_velocity: { max: 1, window_seconds: 600 } });
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const intent = newIntent();
      const base = assessmentBody({ merchant_id: newMerchant(), payer_fingerprint, payment_intent_id: intent });
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => post(ctx, base, `${intent}:risk:${i}`)));
      expect(results.map((r) => r.body.decision)).toEqual(['allow', 'allow', 'allow', 'allow', 'allow']);
      expect(await count(intent)).toBe(5);
      // Y el siguiente intento distinto sí es el segundo: se rechaza.
      expect((await post(ctx, assessmentBody({ merchant_id: base.merchant_id as string, payer_fingerprint }))).body.decision).toBe('deny');
    });
  });

  describe('límites diarios', () => {
    it('correcto: tope diario del pagador 25.000 con intentos de 10.000 evaluados dos veces ⇒ pasan 2 intentos (20.000), no 1', async () => {
      day();
      await publishRules(ctx, { payer_daily_amount_minor: 25_000 });
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const merchant_id = newMerchant();
      const base = () => assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 10_000 });
      const [a1, a2] = await evaluateTwice(newIntent(), base());
      const [b1, b2] = await evaluateTwice(newIntent(), base()); // 10.000 + 10.000 = 20.000 ≤ 25.000 (si contara doble, serían 30.000)
      expect([a1.decision, a2.decision, b1.decision, b2.decision]).toEqual(['allow', 'allow', 'allow', 'allow']);
      const [c1, c2] = await evaluateTwice(newIntent(), base()); // 20.000 + 10.000 = 30.000 > 25.000
      expect([c1.reason_code, c2.reason_code]).toEqual(['payer_daily_limit_exceeded', 'payer_daily_limit_exceeded']);
    });

    it('límite: el tope del comercio se alcanza EXACTO con intentos evaluados dos veces (25.000 = 10.000 + 10.000 + 5.000) y un centavo más no entra', async () => {
      day();
      await publishRules(ctx, { merchant_daily_amount_minor: 25_000 });
      const merchant_id = newMerchant();
      const base = (amount_minor: number) => assessmentBody({ merchant_id, amount_minor });
      for (const amount of [10_000, 10_000, 5_000]) {
        const [a, b] = await evaluateTwice(newIntent(), base(amount));
        expect([a.decision, b.decision]).toEqual(['allow', 'allow']);
      }
      const [over1, over2] = await evaluateTwice(newIntent(), base(1));
      expect([over1.reason_code, over2.reason_code]).toEqual(['daily_limit_exceeded', 'daily_limit_exceeded']);
    });

    it('inválido: un intento rechazado (deny) en CUALQUIERA de sus evaluaciones no consume el límite, aunque su primera evaluación haya sido allow', async () => {
      day();
      await publishRules(ctx, { merchant_daily_amount_minor: 25_000 });
      const merchant_id = newMerchant();
      const intent = newIntent();
      // Primera evaluación limpia; la segunda (del pagador) cae en una lista ⇒ deny. El intento entero queda rechazado.
      const [first, second] = await evaluateTwice(intent, assessmentBody({ merchant_id, amount_minor: 20_000 }), { screening: { merchant_name: 'Comercio Sintetico Qwerty SRL', name: SANCTIONED_ORG, entity_type: 'business' } });
      expect([first.decision, second.decision]).toEqual(['allow', 'deny']);
      // Si el intento rechazado consumiera 20.000, estos 20.000 no entrarían (40.000 > 25.000).
      const next = await post(ctx, assessmentBody({ merchant_id, amount_minor: 20_000 }));
      expect(next.body).toMatchObject({ decision: 'allow' });
    });

    it('inválido: re-evaluar el mismo intento con un importe MENOR no esquiva el límite: cuenta el mayor evaluado', async () => {
      day();
      await publishRules(ctx, { payer_daily_amount_minor: 25_000 });
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const merchant_id = newMerchant();
      const intent = newIntent();
      await evaluateTwice(intent, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 20_000 }), { amount_minor: 1 });
      // Quedan 5.000 de margen (20.000 del intento), no 24.999.
      expect((await post(ctx, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 5_000 }))).body.decision).toBe('allow');
      expect((await post(ctx, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 1 }))).body.decision).toBe('deny');
    });

    it('límite: re-evaluar con un importe MAYOR cuenta el mayor (conservador), igual si las dos evaluaciones tienen la misma hora', async () => {
      day();
      await publishRules(ctx, { payer_daily_amount_minor: 25_000 });
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const merchant_id = newMerchant();
      const intent = newIntent();
      await evaluateTwice(intent, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 10_000 }), { amount_minor: 20_000 });
      expect((await post(ctx, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 5_000 }))).body.decision).toBe('allow');
      expect((await post(ctx, assessmentBody({ merchant_id, payer_fingerprint, amount_minor: 1 }))).body.decision).toBe('deny');
    });
  });

  it('la clave de idempotencia NO agrupa: la misma clave repite una respuesta (200) y NO crea otra evaluación; claves distintas del mismo intento crean evaluaciones que cuentan una vez', async () => {
    const intent = newIntent();
    const body = assessmentBody({ payment_intent_id: intent });
    expect((await post(ctx, body, `${intent}:risk`)).status).toBe(201);
    expect((await post(ctx, body, `${intent}:risk`)).status).toBe(200);
    expect(await count(intent)).toBe(1);
    expect((await post(ctx, body, `${intent}:risk:payer`)).status).toBe(201);
    expect(await count(intent)).toBe(2);
  });
});
