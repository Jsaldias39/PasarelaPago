import { SYNTHETIC_LEGAL_NAME, SYNTHETIC_PAYER_NAME } from '../lib/seed.ts';
import { DEFAULT_INFRA } from '../lib/services.ts';

/**
 * Los nombres sintéticos del arnés NO deben parecerse a ninguna entrada de las listas de sanciones: pay-risk cribaría el comercio y el pagador con
 * Watchman y un puntaje ≥ SANCTIONS_REVIEW_SCORE (0,60) convierte el cobro en `review` ⇒ `deny` (D-30). Se mide contra el Watchman REAL del Compose
 * (listas OFAC de 2019) y se exige un margen amplio, para que un cambio de listas no vuelva rojo un E1 que no tiene nada que ver.
 * No se baja el umbral ni se toca el riesgo: se eligen nombres que no puntúan.
 */
const REVIEW_THRESHOLD = 0.6;
const REQUIRED_MARGIN = 0.15;

async function bestMatch(name: string, type: 'business' | 'person'): Promise<{ match: number; against: string }> {
  const response = await fetch(`${DEFAULT_INFRA.watchmanUrl}/v2/search?${new URLSearchParams({ name, type, minMatch: '0.1', limit: '3' })}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entities: { match: number; name: string }[] | null };
  const top = (body.entities ?? [])[0];
  return { match: top?.match ?? 0, against: top?.name ?? '(sin resultados)' };
}

describe('nombres sintéticos del arnés frente a Watchman', () => {
  it.each([
    ['razón social del comercio (como empresa)', SYNTHETIC_LEGAL_NAME, 'business'],
    ['razón social del comercio (como persona)', SYNTHETIC_LEGAL_NAME, 'person'],
    ['nombre del pagador (como persona)', SYNTHETIC_PAYER_NAME, 'person'],
    ['nombre del pagador (como empresa)', SYNTHETIC_PAYER_NAME, 'business'],
  ] as const)('%s puntúa muy por debajo del umbral de revisión', async (_what, name, type) => {
    const best = await bestMatch(name, type);
    if (process.env.E2E_LOG) process.stdout.write(`${type} «${name}» → ${best.match.toFixed(3)} contra ${best.against}\n`);
    expect(best.match).toBeLessThan(REVIEW_THRESHOLD - REQUIRED_MARGIN);
  });

  it('CONTROL: el cribado reacciona a un nombre que sí está en las listas (la prueba no es vacua)', async () => {
    const best = await bestMatch('J.A.J. BARBOSA Y CIA. S.C.S.', 'business');
    expect(best.match).toBeGreaterThan(REVIEW_THRESHOLD); // el nombre exacto de una entrada puntúa ~0,81 con este Watchman
  });
});
