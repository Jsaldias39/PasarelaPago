/**
 * Escenarios DETERMINISTAS del simulador, elegidos por los **centavos** del importe (`amount_minor % 100`).
 * Cualquier otro importe (centavos 10 a 99) se aprueba. La capa sandbox de la ola 4 reutiliza esta tabla tal cual.
 * Reproducible por semilla: los ids de evento salen de un PRNG con `seed`, no de `Math.random()`.
 */
export type Scenario =
  | 'approved'
  | 'declined'
  | 'delayed'
  | 'duplicate_callback'
  | 'out_of_order'
  | 'lost_callback'
  | 'down'
  | 'ambiguous_timeout'
  | 'never_paid'
  | 'statement_mismatch';

export interface ScenarioInfo {
  readonly cents: number;
  readonly scenario: Scenario;
  readonly example: string;
  readonly behavior: string;
}

export const SCENARIOS: readonly ScenarioInfo[] = [
  { cents: 0, scenario: 'approved', example: 'Bs 100,00', behavior: 'Aprobado: el callback `captured` llega enseguida' },
  { cents: 1, scenario: 'declined', example: 'Bs 100,01', behavior: 'Rechazado de forma síncrona: `failed` con `card_declined`' },
  { cents: 2, scenario: 'delayed', example: 'Bs 100,02', behavior: 'Aprobado, pero el callback llega `delayMs` después (5 s por defecto)' },
  { cents: 3, scenario: 'duplicate_callback', example: 'Bs 100,03', behavior: 'El mismo callback `captured` se entrega 3 veces con el mismo id de evento' },
  { cents: 4, scenario: 'out_of_order', example: 'Bs 100,04', behavior: 'Llega `captured` y DESPUÉS `authorized` (hecho anterior, fuera de orden)' },
  { cents: 5, scenario: 'lost_callback', example: 'Bs 100,05', behavior: 'El callback nunca llega; solo la consulta de estado revela `captured`' },
  { cents: 6, scenario: 'down', example: 'Bs 100,06', behavior: 'El conector está caído: `createCharge` falla sin crear nada (seguro de reintentar o pasar a otro)' },
  { cents: 7, scenario: 'ambiguous_timeout', example: 'Bs 100,07', behavior: 'El cobro se crea pero la respuesta se pierde (timeout ambiguo); reintentar con la misma referencia devuelve el mismo cobro' },
  { cents: 8, scenario: 'never_paid', example: 'Bs 100,08', behavior: 'Nadie paga: pasa a `expired` al llegar `expires_at`' },
  { cents: 9, scenario: 'statement_mismatch', example: 'Bs 100,09', behavior: 'Se cobra bien, pero el extracto trae Bs 1,00 menos (diferencia para la conciliación)' },
];

export function scenarioFor(amountMinor: bigint): Scenario {
  const cents = Number(amountMinor % 100n);
  return SCENARIOS.find((s) => s.cents === cents)?.scenario ?? 'approved';
}

/** PRNG de 32 bits con semilla (mulberry32): lo mismo con la misma semilla, siempre. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Variantes AMBIGUAS de una transferencia saliente (el simulador la EJECUTA pero la respuesta no sirve), por los dos últimos dígitos:
 * 07 ⇒ timeout, 17 ⇒ un proxy contesta 502 con HTML, 27 ⇒ el socket se corta. Para pay-settlement: su política ante lo ambiguo.
 */
export function transferAmbiguity(amountMinor: bigint): 'timeout' | 'proxy_bad_gateway_html' | 'socket_reset' | null {
  switch (Number(amountMinor % 100n)) {
    case 7:
      return 'timeout';
    case 17:
      return 'proxy_bad_gateway_html';
    case 27:
      return 'socket_reset';
    default:
      return null;
  }
}
