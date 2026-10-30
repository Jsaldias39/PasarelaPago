/**
 * Escenarios DETERMINISTAS del banco simulado, elegidos por los **centavos** del importe (`amount_minor % 100`).
 * Cualquier otro importe (centavos 10 a 99) se aprueba. Es la tabla que documenta el README y que ejercita `test/scenarios.spec.ts`
 * (un caso por fila). No es la de ningún banco real: los bancos reales no eligen su comportamiento por el importe.
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
  { cents: 0, scenario: 'approved', example: 'Bs 100,00', behavior: 'Aprobado: el callback `captured` se entrega enseguida' },
  { cents: 1, scenario: 'declined', example: 'Bs 100,01', behavior: 'Rechazado de forma síncrona: `failed` con `card_declined` (nunca se paga)' },
  { cents: 2, scenario: 'delayed', example: 'Bs 100,02', behavior: 'Aprobado, pero el pago (y su callback) ocurre `MOCKBANK_DELAY_MS` después (5 s por defecto)' },
  { cents: 3, scenario: 'duplicate_callback', example: 'Bs 100,03', behavior: 'El mismo callback `captured` se entrega 3 veces con el mismo id de evento' },
  { cents: 4, scenario: 'out_of_order', example: 'Bs 100,04', behavior: 'Se entrega `captured` y DESPUÉS `authorized` (hecho anterior, fuera de orden)' },
  { cents: 5, scenario: 'lost_callback', example: 'Bs 100,05', behavior: 'El callback nunca se entrega; solo la consulta de estado revela `captured`' },
  { cents: 6, scenario: 'down', example: 'Bs 100,06', behavior: 'Banco caído: responde 503 `bank_unavailable` sin crear nada (seguro reintentar o pasar a otro)' },
  { cents: 7, scenario: 'ambiguous_timeout', example: 'Bs 100,07', behavior: 'El cobro se crea pero la conexión se corta antes de responder; repetir la misma referencia devuelve el mismo cobro' },
  { cents: 8, scenario: 'never_paid', example: 'Bs 100,08', behavior: 'Nadie paga: pasa a `expired` al llegar `expires_at`' },
  { cents: 9, scenario: 'statement_mismatch', example: 'Bs 100,09', behavior: 'Se cobra bien, pero el extracto trae Bs 1,00 menos (diferencia para la conciliación)' },
];

export function scenarioFor(amountMinor: bigint): Scenario {
  const cents = Number(amountMinor % 100n);
  return SCENARIOS.find((s) => s.cents === cents)?.scenario ?? 'approved';
}

/**
 * Variantes AMBIGUAS de una transferencia saliente (el banco la EJECUTA pero la respuesta no sirve), por los dos últimos dígitos:
 * 07 ⇒ la conexión se corta (sin respuesta), 17 ⇒ un proxy contesta 502 con HTML, 27 ⇒ el socket se resetea.
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
