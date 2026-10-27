import { evaluate, type Facts, type History, type RuleSet } from '../src/rules/engine';
import type { ScreeningResult } from '../src/screening/screener';

const NONE: RuleSet = { version: 1, maxAmountMinor: null, merchantDailyAmountMinor: null, payerDailyAmountMinor: null, payerVelocity: null, merchantVelocity: null, hours: null };
const EMPTY: History = { payerAttempts: 0, merchantAttempts: 0, payerDailyMinor: 0n, merchantDailyMinor: 0n };
const CLEAR: ScreeningResult = { outcome: 'clear' };
const facts = (over: Partial<Facts> = {}): Facts => ({ amountMinor: 1000n, localHour: 12, payerKnown: true, screening: CLEAR, ...over });

describe('motor de reglas (P5.H2.M2): función pura, sin límites por defecto (D-23)', () => {
  it('sin ninguna regla cargada y cribado limpio: allow con `no_limits_configured`, para que se vea que no hay límites', () => {
    expect(evaluate(NONE, facts(), EMPTY)).toEqual({ decision: 'allow', reasonCode: 'no_limits_configured', reasonCodes: [], screened: true });
  });

  it('con al menos una regla cargada y nada que la active: allow `ok`', () => {
    expect(evaluate({ ...NONE, maxAmountMinor: 5000n }, facts(), EMPTY)).toMatchObject({ decision: 'allow', reasonCode: 'ok' });
    expect(evaluate({ ...NONE, hours: { from: 8, to: 20 } }, facts(), EMPTY)).toMatchObject({ decision: 'allow', reasonCode: 'ok' });
  });

  describe('límite por transacción: el borde es inclusivo', () => {
    const rules = { ...NONE, maxAmountMinor: 5000n };
    it.each([
      [4999n, 'allow'],
      [5000n, 'allow'],
      [5001n, 'deny'],
    ])('importe %s ⇒ %s', (amountMinor, decision) => {
      const verdict = evaluate(rules, facts({ amountMinor }), EMPTY);
      expect(verdict.decision).toBe(decision);
      if (decision === 'deny') expect(verdict.reasonCode).toBe('amount_over_limit');
    });
  });

  describe('límite diario (ventana móvil de 24 h): lo ya comprometido + este importe', () => {
    it.each([
      ['comercio', { merchantDailyAmountMinor: 10_000n }, { merchantDailyMinor: 9000n }, 'daily_limit_exceeded'],
      ['pagador', { payerDailyAmountMinor: 10_000n }, { payerDailyMinor: 9000n }, 'payer_daily_limit_exceeded'],
    ] as const)('%s: 9000 + 1000 llega justo al tope (allow), 9001 + 1000 lo pasa (deny)', (_name, rule, hist, code) => {
      const rules = { ...NONE, ...rule };
      expect(evaluate(rules, facts(), { ...EMPTY, ...hist }).decision).toBe('allow');
      const over = Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, v + 1n]));
      expect(evaluate(rules, facts(), { ...EMPTY, ...over })).toMatchObject({ decision: 'deny', reasonCode: code });
    });
  });

  describe('velocidad: el intento actual es el (n+1)-ésimo', () => {
    it.each([
      ['pagador', { payerVelocity: { max: 3, windowSeconds: 60 } }, 'payerAttempts', 'velocity_exceeded'],
      ['comercio', { merchantVelocity: { max: 3, windowSeconds: 60 } }, 'merchantAttempts', 'merchant_velocity_exceeded'],
    ] as const)('%s: con 2 previos pasa, con 3 previos se rechaza', (_name, rule, field, code) => {
      const rules = { ...NONE, ...rule };
      expect(evaluate(rules, facts(), { ...EMPTY, [field]: 2 }).decision).toBe('allow');
      expect(evaluate(rules, facts(), { ...EMPTY, [field]: 3 })).toMatchObject({ decision: 'deny', reasonCode: code });
    });
  });

  describe('horario permitido [from, to) en hora de La Paz', () => {
    const rules = { ...NONE, hours: { from: 8, to: 20 } };
    it.each([[7, 'review'], [8, 'allow'], [19, 'allow'], [20, 'review'], [0, 'review'], [23, 'review']])('hora %s ⇒ %s', (localHour, decision) => {
      const verdict = evaluate(rules, facts({ localHour }), EMPTY);
      expect(verdict.decision).toBe(decision);
      if (decision === 'review') expect(verdict.reasonCode).toBe('outside_allowed_hours');
    });
    it('0–24 permite todo el día', () => {
      for (let h = 0; h < 24; h += 1) expect(evaluate({ ...NONE, hours: { from: 0, to: 24 } }, facts({ localHour: h }), EMPTY).decision).toBe('allow');
    });
  });

  describe('sanciones', () => {
    it('match ⇒ deny sanctions_match; coincidencia aproximada ⇒ review sanctions_possible_match; ambas con screened true', () => {
      expect(evaluate(NONE, facts({ screening: { outcome: 'match', topScore: 0.9 } }), EMPTY)).toMatchObject({ decision: 'deny', reasonCode: 'sanctions_match', screened: true });
      expect(evaluate(NONE, facts({ screening: { outcome: 'possible_match', topScore: 0.65 } }), EMPTY)).toMatchObject({ decision: 'review', reasonCode: 'sanctions_possible_match', screened: true });
    });
    it('cribado caído ⇒ review `screening_unavailable` con screened false (nunca allow)', () => {
      expect(evaluate(NONE, facts({ screening: { outcome: 'unavailable' } }), EMPTY)).toMatchObject({ decision: 'review', reasonCode: 'screening_unavailable', screened: false });
    });
    it('sin nombre a cribar ⇒ review `screening_not_provided` con screened false', () => {
      expect(evaluate(NONE, facts({ screening: 'not_provided' }), EMPTY)).toMatchObject({ decision: 'review', reasonCode: 'screening_not_provided', screened: false });
    });
  });

  it('límite por pagador sin pagador identificado ⇒ review `payer_unidentified` (no se deja pasar en silencio)', () => {
    for (const rule of [{ payerVelocity: { max: 1, windowSeconds: 10 } }, { payerDailyAmountMinor: 100n }]) {
      expect(evaluate({ ...NONE, ...rule }, facts({ payerKnown: false, amountMinor: 1n }), EMPTY)).toMatchObject({ decision: 'review', reasonCode: 'payer_unidentified' });
    }
    // Y sin límites por pagador, no identificar al pagador no molesta.
    expect(evaluate({ ...NONE, maxAmountMinor: 5000n }, facts({ payerKnown: false }), EMPTY).decision).toBe('allow');
  });

  it('prioridad: deny gana a review; entre denys manda el orden fijo; todos los motivos quedan en `reasonCodes`', () => {
    const rules: RuleSet = { ...NONE, maxAmountMinor: 100n, payerVelocity: { max: 1, windowSeconds: 60 }, hours: { from: 8, to: 20 } };
    const verdict = evaluate(rules, facts({ amountMinor: 500n, localHour: 3, screening: { outcome: 'possible_match', topScore: 0.7 } }), { ...EMPTY, payerAttempts: 1 });
    expect(verdict).toMatchObject({ decision: 'deny', reasonCode: 'amount_over_limit' });
    expect(verdict.reasonCodes).toEqual(['amount_over_limit', 'velocity_exceeded', 'sanctions_possible_match', 'outside_allowed_hours']);
    const sanctions = evaluate(rules, facts({ amountMinor: 500n, screening: { outcome: 'match', topScore: 0.9 } }), EMPTY);
    expect(sanctions.reasonCode).toBe('sanctions_match');
  });

  it('propiedad exhaustiva (todas las combinaciones): nunca allow si no se cribó; el motivo principal es el primero de reasonCodes; allow no trae motivos de regla', () => {
    const screenings: (ScreeningResult | 'not_provided')[] = [CLEAR, { outcome: 'possible_match', topScore: 0.7 }, { outcome: 'match', topScore: 0.9 }, { outcome: 'unavailable' }, 'not_provided'];
    const ruleSets: RuleSet[] = [
      NONE,
      { ...NONE, maxAmountMinor: 500n },
      { ...NONE, payerVelocity: { max: 1, windowSeconds: 10 }, merchantVelocity: { max: 1, windowSeconds: 10 } },
      { ...NONE, merchantDailyAmountMinor: 800n, payerDailyAmountMinor: 800n, hours: { from: 9, to: 17 } },
    ];
    let combos = 0;
    for (const rules of ruleSets) {
      for (const screening of screenings) {
        for (const amountMinor of [1n, 500n, 501n, 1000n]) {
          for (const localHour of [3, 12]) {
            for (const payerKnown of [true, false]) {
              for (const attempts of [0, 1]) {
                for (const daily of [0n, 400n, 900n]) {
                  const verdict = evaluate(rules, { amountMinor, localHour, payerKnown, screening }, { payerAttempts: attempts, merchantAttempts: attempts, payerDailyMinor: daily, merchantDailyMinor: daily });
                  combos += 1;
                  const screened = screening !== 'not_provided' && screening.outcome !== 'unavailable';
                  expect(verdict.screened).toBe(screened);
                  if (!screened) expect(verdict.decision).not.toBe('allow');
                  if (verdict.decision === 'allow') expect(verdict.reasonCodes).toEqual([]);
                  else expect(verdict.reasonCode).toBe(verdict.reasonCodes[0]);
                  expect(['allow', 'review', 'deny']).toContain(verdict.decision);
                }
              }
            }
          }
        }
      }
    }
    expect(combos).toBe(4 * 5 * 4 * 2 * 2 * 2 * 3);
  });
});
