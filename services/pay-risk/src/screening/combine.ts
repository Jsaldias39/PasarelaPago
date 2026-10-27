import type { ScreeningParty, ScreeningResult } from './screener';

const SEVERITY: Record<ScreeningResult['outcome'], number> = { clear: 0, possible_match: 1, unavailable: 2, match: 3 };

/**
 * D-29: se criba SIEMPRE el nombre legal del comercio y, si el pagador dio nombre, también el suyo. El resultado del cobro es el más
 * grave de los dos: una coincidencia fuerte de cualquiera manda (`match`), luego que alguno no se haya podido cribar (`unavailable`: no se
 * puede afirmar que está limpio), luego la coincidencia aproximada, y solo si ambos están limpios, `clear`. El detalle (puntaje, lista, id
 * público) y la parte (`merchant`|`payer`) son los de la coincidencia de mayor puntaje.
 */
export function combineScreenings(parts: { party: ScreeningParty; result: ScreeningResult }[]): ScreeningResult {
  if (parts.length === 0) throw new RangeError('Nada que combinar');
  const worst = parts.reduce((top, part) => (SEVERITY[part.result.outcome] > SEVERITY[top.result.outcome] ? part : top));
  const best = parts.reduce<(typeof parts)[number] | undefined>((top, part) => (part.result.topScore !== undefined && (top === undefined || part.result.topScore > (top.result.topScore ?? -1)) ? part : top), undefined);
  const detail = best ?? worst;
  return {
    outcome: worst.result.outcome,
    party: detail.party,
    ...(detail.result.topScore !== undefined && { topScore: detail.result.topScore }),
    ...(detail.result.list !== undefined && { list: detail.result.list }),
    ...(detail.result.sourceId !== undefined && { sourceId: detail.result.sourceId }),
  };
}
