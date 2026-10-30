import type { Queryable } from '@pay/outbox';

/**
 * Lo único que se le pide al `EntityManager` (de `@mikro-orm/postgresql`): `execute`, que dentro de
 * `em.transactional(...)` usa **la transacción activa** (en MikroORM 7, «an active transaction always takes precedence»).
 */
export interface EntityManagerLike {
  execute(query: string, params?: unknown[], method?: 'all' | 'get' | 'run'): Promise<unknown>;
}

/**
 * Traduce los marcadores de `pg` (`$1`, `$2`…, que pueden repetirse o ir desordenados) a los de MikroORM (`?`),
 * y reordena los parámetros. LÍMITE: no admite un `?` literal en el SQL (operadores de jsonb como `?|`): usá `jsonb_exists`.
 */
export function toMikroOrmSql(text: string, params: readonly unknown[] = []): { sql: string; params: unknown[] } {
  if (text.includes('?')) throw new RangeError('El SQL no puede contener «?» literal: MikroORM lo toma como marcador (usá jsonb_exists en vez de ?)');
  const ordered: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index) - 1;
    if (position < 0 || position >= params.length) throw new RangeError(`El marcador $${index} no tiene parámetro`);
    ordered.push(params[position]);
    return '?';
  });
  return { sql, params: ordered };
}

const RETURNS_ROWS = /^\s*(select|with|values)\b|\breturning\b/i;

/**
 * Adaptador: da a las librerías de `@pay/*` (outbox, idempotencia) una interfaz `Queryable` sobre la transacción de MikroORM.
 *
 * ```ts
 * await em.transactional(async (tx) => {
 *   tx.persist(order);                                   // la entidad
 *   await enqueue(ormQueryable(tx), event, { ... });     // su evento, en la MISMA transacción
 * });                                                    // se confirma o se deshace todo junto
 * ```
 *
 * Pasá el `em` que recibe el callback de `transactional` (o el que tiene `begin()` abierto), no el global.
 */
export function ormQueryable(em: EntityManagerLike): Queryable {
  return {
    async query(text, params = []) {
      const translated = toMikroOrmSql(text, params);
      if (RETURNS_ROWS.test(text)) {
        const rows = (await em.execute(translated.sql, translated.params, 'all')) as Record<string, unknown>[];
        return { rows, rowCount: rows.length };
      }
      const result = (await em.execute(translated.sql, translated.params, 'run')) as { affectedRows?: number; rowCount?: number };
      return { rows: [], rowCount: result.affectedRows ?? result.rowCount ?? null };
    },
  };
}
