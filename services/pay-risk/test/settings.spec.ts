import { loadRiskSettings } from '../src/settings';

const BASE = { WATCHMAN_URL: 'http://watchman:8084', SANCTIONS_DENY_SCORE: '0.8', SANCTIONS_REVIEW_SCORE: '0.6', PAYER_HASH_KEY: 'x'.repeat(16) };

describe('configuración de pay-risk: umbrales y secretos SIN valor por defecto (regla 90.3.4)', () => {
  it('correcto: lee los valores y fija solo el tiempo máximo de cribado por defecto (200 ms)', () => {
    expect(loadRiskSettings(BASE)).toEqual({ watchmanUrl: 'http://watchman:8084', screeningTimeoutMs: 200, sanctionsDenyScore: 0.8, sanctionsReviewScore: 0.6, payerHashKey: 'x'.repeat(16) });
  });

  it.each(['WATCHMAN_URL', 'SANCTIONS_DENY_SCORE', 'SANCTIONS_REVIEW_SCORE', 'PAYER_HASH_KEY'])('falta %s ⇒ no arranca', (name) => {
    const env: Record<string, string | undefined> = { ...BASE };
    delete env[name];
    expect(() => loadRiskSettings(env)).toThrow(name);
    expect(() => loadRiskSettings({ ...env, [name]: '' })).toThrow(name);
  });

  it.each([
    ['0'], ['-0.5'], ['1.01'], ['2'], ['abc'], ['0.8abc'], ['1e-1'], ['.5'], [' 0.8'], ['NaN'],
  ])('puntaje %p inválido ⇒ no arranca', (raw) => {
    expect(() => loadRiskSettings({ ...BASE, SANCTIONS_DENY_SCORE: raw })).toThrow(/SANCTIONS_DENY_SCORE/);
  });

  it('límite: 1 y 1.0 valen; el de revisión puede igualar al de rechazo pero no superarlo', () => {
    expect(loadRiskSettings({ ...BASE, SANCTIONS_DENY_SCORE: '1', SANCTIONS_REVIEW_SCORE: '1' }).sanctionsDenyScore).toBe(1);
    expect(loadRiskSettings({ ...BASE, SANCTIONS_DENY_SCORE: '0.7', SANCTIONS_REVIEW_SCORE: '0.7' }).sanctionsReviewScore).toBe(0.7);
    expect(() => loadRiskSettings({ ...BASE, SANCTIONS_DENY_SCORE: '0.7', SANCTIONS_REVIEW_SCORE: '0.71' })).toThrow(/no puede ser mayor/);
  });

  it('el tiempo máximo del cribado queda dentro del presupuesto de 300 ms: 1–250', () => {
    expect(loadRiskSettings({ ...BASE, SCREENING_TIMEOUT_MS: '250' }).screeningTimeoutMs).toBe(250);
    for (const bad of ['0', '251', '1.5', 'x', '-1']) expect(() => loadRiskSettings({ ...BASE, SCREENING_TIMEOUT_MS: bad })).toThrow(/SCREENING_TIMEOUT_MS/);
  });

  it('la URL de Watchman debe ser http(s); la clave de huella tiene al menos 16 caracteres', () => {
    expect(() => loadRiskSettings({ ...BASE, WATCHMAN_URL: 'ftp://x' })).toThrow(/WATCHMAN_URL/);
    expect(() => loadRiskSettings({ ...BASE, WATCHMAN_URL: 'watchman:8084' })).toThrow(/WATCHMAN_URL/);
    expect(loadRiskSettings({ ...BASE, WATCHMAN_URL: 'http://watchman:8084///' }).watchmanUrl).toBe('http://watchman:8084');
    expect(() => loadRiskSettings({ ...BASE, PAYER_HASH_KEY: 'corta' })).toThrow(/PAYER_HASH_KEY/);
  });
});
