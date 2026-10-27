/**
 * Cortacircuitos mínimo por servicio de destino.
 *
 * - `closed`: deja pasar; `failureThreshold` fallos CONSECUTIVOS lo abren.
 * - `open`: rechaza al instante durante `cooldownMs` (no se le suma carga a un servicio caído).
 * - `half-open`: pasado el enfriamiento deja pasar UNA sola prueba; si sale bien se cierra, si falla se vuelve a abrir.
 *
 * Solo cuentan como fallo los errores del destino (red, tiempo, 5xx); un 4xx es una respuesta válida.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private current: BreakerState = 'closed';

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    return this.current;
  }

  /** Milisegundos que faltan para la próxima prueba (0 si no está abierto). */
  retryAfterMs(): number {
    return this.current === 'open' ? Math.max(0, this.openedAt + this.cooldownMs - this.now()) : 0;
  }

  /** ¿Puede salir esta petición? Si está en prueba, solo la primera. */
  tryAcquire(): boolean {
    if (this.current === 'closed') return true;
    if (this.current === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.current = 'half-open';
      this.probing = false;
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.probing = false;
    this.current = 'closed';
  }

  onFailure(): void {
    this.probing = false;
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.failureThreshold) {
      this.current = 'open';
      this.openedAt = this.now();
    }
  }
}
