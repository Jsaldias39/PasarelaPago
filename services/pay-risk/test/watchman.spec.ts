import { WatchmanScreener } from '../src/screening/watchman.screener';
import { loadRiskSettings, type RiskSettings } from '../src/settings';
import { FUNCTIONAL_TIMEOUT_MS } from './support/app';
import { CLEAN_NAME, SANCTIONED_ORG, SANCTIONED_ORG_TYPO } from './support/http';
import { entity, json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

// Tiempo máximo holgado: el Watchman local se comparte con otros carriles (ver FUNCTIONAL_TIMEOUT_MS en support/app.ts).
const real = (over: Partial<RiskSettings> = {}) => new WatchmanScreener({ ...loadRiskSettings(), screeningTimeoutMs: FUNCTIONAL_TIMEOUT_MS, ...over });

describe('cribado de sanciones contra moov Watchman REAL (v2-static, listas de 2019 SOLO sandbox) — P5.H2.M3', () => {
  it('correcto: una entrada pública de la lista (Hizballah) es `match` con su lista y su id; no se inventa ningún dato', async () => {
    const result = await real().screen(SANCTIONED_ORG);
    expect(result.outcome).toBe('match');
    expect(result.topScore).toBeGreaterThanOrEqual(0.8);
    expect(result).toMatchObject({ list: 'us_ofac', sourceId: expect.stringMatching(/^\d+$/) });
  });

  it('correcto: un nombre sintético que no figura en la lista es `clear`', async () => {
    const result = await real().screen(CLEAN_NAME);
    expect(result.outcome).toBe('clear');
  });

  it('el umbral manda, no «hubo resultados»: el mismo nombre con una letra cambiada es `possible_match` entre revisión y rechazo, y `clear` bajo la revisión', async () => {
    const typo = await real().screen(SANCTIONED_ORG_TYPO);
    expect(typo.topScore).toBeGreaterThan(0.6);
    expect(typo.topScore).toBeLessThan(0.8);
    expect(typo.outcome).toBe('possible_match');
    const strict = await real({ sanctionsReviewScore: 0.7, sanctionsDenyScore: 0.8 }).screen(SANCTIONED_ORG_TYPO);
    expect(strict.outcome).toBe('clear');
  });

  it('límite: el umbral es inclusivo — con el umbral igual al puntaje exacto es `match`; un epsilon por encima ya no', async () => {
    const exact = (await real().screen(SANCTIONED_ORG)).topScore as number;
    expect((await real({ sanctionsDenyScore: exact, sanctionsReviewScore: exact }).screen(SANCTIONED_ORG)).outcome).toBe('match');
    const above = Math.min(1, exact + 1e-6);
    expect((await real({ sanctionsDenyScore: above, sanctionsReviewScore: exact }).screen(SANCTIONED_ORG)).outcome).toBe('possible_match');
    expect((await real({ sanctionsDenyScore: above, sanctionsReviewScore: above }).screen(SANCTIONED_ORG)).outcome).toBe('clear');
  });

  it('límite: nombres raros no rompen la búsqueda (acentos, comillas, símbolos, 200 caracteres)', async () => {
    for (const name of ['José Ñandú Pérez', `O'Brien & Sons "SRL"`, '%&=?# /\\', 'a'.repeat(200), '日本語の名前']) {
      const result = await real().screen(name);
      expect({ name: name.slice(0, 10), outcome: result.outcome }).not.toMatchObject({ outcome: 'unavailable' });
    }
  });

  it('inválido: Watchman inalcanzable ⇒ `unavailable` (nunca `clear`), sin lanzar', async () => {
    const result = await real({ watchmanUrl: 'http://127.0.0.1:1' }).screen(SANCTIONED_ORG);
    expect(result).toEqual({ outcome: 'unavailable' });
  });
});

describe('[DOBLE] de Watchman: lo que el real no produce a pedido', () => {
  let double: WatchmanDouble;
  const screener = (over: Partial<RiskSettings> = {}) => new WatchmanScreener({ ...loadRiskSettings(), watchmanUrl: double.url, ...over });
  beforeEach(async () => {
    double = await startWatchmanDouble((_req, res) => json(res, { entities: null }));
  });
  afterEach(async () => double.close());

  it('correcto: a Watchman le manda SOLO nombre, tipo, umbral y límite; prueba persona y empresa', async () => {
    await screener().screen('Nombre Sintético');
    expect(double.requests.map((r) => r.path)).toEqual(['/v2/search', '/v2/search']);
    expect(double.requests.map((r) => r.params.type).sort()).toEqual(['business', 'person']);
    for (const request of double.requests) {
      expect(Object.keys(request.params).sort()).toEqual(['limit', 'minMatch', 'name', 'type']);
      expect(request.params.name).toBe('Nombre Sintético');
      expect(request.params.minMatch).toBe('0.6');
    }
  });

  it('`entities: null` (nada alcanzó el umbral) es `clear`', async () => {
    expect((await screener().screen('x')).outcome).toBe('clear');
  });

  it('toma el MAYOR puntaje de las dos búsquedas', async () => {
    double.behavior = (_req, res, type) => json(res, { entities: [entity(type === 'person' ? 0.65 : 0.7)] });
    expect(await screener().screen('x')).toMatchObject({ outcome: 'possible_match', topScore: 0.7, list: 'us_ofac', sourceId: '4697' });
  });

  it('una búsqueda caída con la otra limpia ⇒ `unavailable` (dudar es más seguro que dejar pasar)', async () => {
    double.behavior = (_req, res, type) => (type === 'person' ? json(res, { entities: null }) : json(res, { error: 'boom' }, 500));
    expect((await screener().screen('x')).outcome).toBe('unavailable');
  });

  it('una coincidencia fuerte manda aunque la otra búsqueda haya fallado: `match`', async () => {
    double.behavior = (_req, res, type) => (type === 'person' ? json(res, { entities: [entity(0.95)] }) : json(res, {}, 503));
    expect(await screener().screen('x')).toMatchObject({ outcome: 'match', topScore: 0.95 });
  });

  it.each([
    ['HTTP 500', (_req: unknown, res: any) => json(res, { entities: [] }, 500)],
    ['HTTP 404', (_req: unknown, res: any) => json(res, {}, 404)],
    ['JSON roto', (_req: unknown, res: any) => { res.writeHead(200); res.end('{"entities": ['); }],
    ['cuerpo vacío', (_req: unknown, res: any) => { res.writeHead(200); res.end(); }],
    ['sin campo entities', (_req: unknown, res: any) => json(res, { ok: true })],
    ['entities no es lista', (_req: unknown, res: any) => json(res, { entities: 'x' })],
    ['entrada sin match', (_req: unknown, res: any) => json(res, { entities: [{ name: 'x' }] })],
    ['match fuera de rango (1.5)', (_req: unknown, res: any) => json(res, { entities: [entity(1.5)] })],
    ['match negativo', (_req: unknown, res: any) => json(res, { entities: [entity(-0.1)] })],
    ['match como texto', (_req: unknown, res: any) => json(res, { entities: [entity('0.99' as unknown as number)] })],
    ['entrada nula', (_req: unknown, res: any) => json(res, { entities: [null] })],
    ['conexión cortada', (req: any) => req.socket.destroy()],
  ])('inválido: %s ⇒ `unavailable`, nunca `clear`', async (_name, behavior) => {
    double.behavior = behavior as never;
    expect((await screener().screen('x')).outcome).toBe('unavailable');
  });

  it('inválido: una respuesta lenta se corta en el tiempo máximo ⇒ `unavailable`, y a tiempo', async () => {
    double.behavior = () => undefined; // nunca responde
    const started = Date.now();
    const result = await screener({ screeningTimeoutMs: 60 }).screen('x');
    expect(result.outcome).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('el nombre no aparece en los logs del cribado cuando falla', async () => {
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      double.behavior = (_req, res) => json(res, {}, 500);
      await screener().screen('CENTINELA-NOMBRE-PRIVADO');
    } finally {
      process.stdout.write = original;
    }
    expect(lines.join('')).toContain('Watchman no pudo cribar'); // sí registró el fallo…
    expect(lines.join('')).not.toContain('CENTINELA-NOMBRE-PRIVADO'); // …pero sin el nombre
  });
});
