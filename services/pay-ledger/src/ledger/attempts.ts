/**
 * Regla de intentos (H-TB1), que el SERVIDOR hace cumplir en vez de confiar en el llamador:
 *
 *  - Repetir el mismo (business_ref, attempt) es idempotente (o `idempotency_key_reused` si el contenido difiere).
 *  - Si algún intento del business_ref fue ACEPTADO, ningún otro attempt es válido (movería el dinero dos veces).
 *  - Solo se admite `attempt = N + 1` cuando el intento `N` existe y fue rechazado; el primero es 1, sin saltos.
 */
export interface AttemptRow {
  readonly attempt: number;
  readonly status: string;
  readonly content_hash: string;
}

export type AttemptDecision<R extends AttemptRow> = { kind: 'same'; row: R } | { kind: 'conflict'; reason: string } | { kind: 'proceed' };

export function decideAttempt<R extends AttemptRow>(rows: readonly R[], attempt: number): AttemptDecision<R> {
  const same = rows.find((row) => row.attempt === attempt);
  if (same) return { kind: 'same', row: same };
  if (rows.some((row) => row.status !== 'rejected')) {
    return { kind: 'conflict', reason: 'El business_ref ya tiene un intento aceptado' };
  }
  const expected = rows.reduce((max, row) => Math.max(max, row.attempt), 0) + 1;
  if (attempt !== expected) return { kind: 'conflict', reason: `El siguiente attempt válido es ${expected}` };
  return { kind: 'proceed' };
}
