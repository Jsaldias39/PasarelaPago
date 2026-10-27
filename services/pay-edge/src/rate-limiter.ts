/**
 * Limitador de velocidad en Redis: ventana fija por clave, contada con un script Lua para que `INCR` y `EXPIRE` sean
 * atómicos (sin la carrera «INCR y se cae antes de EXPIRE» que deja una clave eterna).
 *
 * Una ventana fija admite hasta 2× el límite alrededor del borde de dos ventanas: aceptado para un borde que solo quiere
 * frenar abuso; el control fino por comercio es de negocio. Si Redis no responde, `hit` devuelve `unavailable` y quien lo
 * llama decide (pay-edge deja pasar y lo registra: ver docs/trabajo/ola-1/P1/DECISIONES-TOMADAS.md, DT-1).
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export type RateDecision =
  | { readonly status: 'ok'; readonly count: number; readonly limit: number; readonly retryAfterSeconds: number }
  | { readonly status: 'limited'; readonly count: number; readonly limit: number; readonly retryAfterSeconds: number }
  | { readonly status: 'unavailable' };

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly windowSeconds: number,
  ) {}

  /** Cuenta un pedido contra `key` y dice si pasa. */
  async hit(key: string, limit: number): Promise<RateDecision> {
    try {
      const [count, ttl] = (await this.redis.eval(SCRIPT, 1, `${this.prefix}:${key}`, this.windowSeconds)) as [number, number];
      const retryAfterSeconds = Math.max(1, ttl);
      return count > limit ? { status: 'limited', count, limit, retryAfterSeconds } : { status: 'ok', count, limit, retryAfterSeconds };
    } catch {
      return { status: 'unavailable' };
    }
  }

  /** Cuántos pedidos van en la ventana actual de `key`, sin contar uno nuevo. `null` si Redis no responde. */
  async peek(key: string): Promise<number | null> {
    try {
      return Number((await this.redis.get(`${this.prefix}:${key}`)) ?? 0);
    } catch {
      return null;
    }
  }
}
