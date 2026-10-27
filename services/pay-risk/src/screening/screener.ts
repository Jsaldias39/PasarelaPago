/**
 * Cribado de sanciones. El contrato es lo que `AssessmentsService` consume; la implementación real es
 * `WatchmanScreener` (moov Watchman por HTTP). A Watchman solo viaja el nombre y el tipo (regla 90.2).
 */
export type ScreeningOutcome =
  /** Se cribó y nada alcanzó el umbral de revisión. */
  | 'clear'
  /** Coincidencia aproximada: entre el umbral de revisión y el de rechazo. */
  | 'possible_match'
  /** Coincidencia fuerte: desde el umbral de rechazo. */
  | 'match'
  /** No se pudo cribar (Watchman caído, lento o con respuesta inválida). Nunca equivale a `clear`. */
  | 'unavailable';

export type ScreeningEntityType = 'person' | 'business';

export type ScreeningParty = 'merchant' | 'payer';

export interface ScreeningResult {
  /** A quién pertenece la mejor coincidencia (D-29: se criba al comercio y, si dio nombre, al pagador). */
  readonly party?: ScreeningParty;
  readonly outcome: ScreeningOutcome;
  /** Mayor puntaje devuelto por Watchman (0–1), si hubo respuesta. */
  readonly topScore?: number;
  /** Lista pública de la mejor coincidencia (por ejemplo `us_ofac`) y el id de su entrada. No son datos del pagador. */
  readonly list?: string;
  readonly sourceId?: string;
}

export interface SanctionsScreener {
  /** Nunca lanza: ante cualquier fallo devuelve `{ outcome: 'unavailable' }`. */
  /** `entityType` opcional: si se conoce, se hace UNA búsqueda en vez de dos (Watchman es el cuello de botella). */
  screen(name: string, entityType?: ScreeningEntityType): Promise<ScreeningResult>;
}

export const SANCTIONS_SCREENER = Symbol('SANCTIONS_SCREENER');
