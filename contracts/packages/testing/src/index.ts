import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/** Base de pruebas del Compose local (`platform/compose.yml`, puerto 54321). Se cambia con `PAY_TEST_DATABASE_URL`. */
export const TEST_DATABASE_URL =
  process.env.PAY_TEST_DATABASE_URL ?? 'postgres://postgres:pay@127.0.0.1:54321/pay_test';

export interface IsolatedDatabaseOptions {
  readonly max?: number;
}

export interface IsolatedDatabase {
  readonly pool: Pool;
  readonly schema: string;
  /** Borra el esquema y cierra el pool. */
  drop(): Promise<void>;
}

function poolMax(requested: number | undefined): number {
  const value = requested ?? Number(process.env.PAY_TEST_POOL_MAX ?? 60);
  if (!Number.isInteger(value) || value < 1 || value > 400) throw new RangeError(`Tamaño de pool inválido: ${requested ?? process.env.PAY_TEST_POOL_MAX}`);
  return value;
}

/**
 * Crea un esquema nuevo en la base de pruebas, aplica los archivos SQL y devuelve un pool cuyo
 * `search_path` apunta a ese esquema. Cada archivo de pruebas usa el suyo: no se pisan entre sí
 * y se prueba contra Postgres real, no contra un ORM mockeado.
 *
 * @param sqlFiles - Rutas de archivos SQL a aplicar, en orden.
 * @param options - `max`: conexiones del pool (por defecto `PAY_TEST_POOL_MAX` o 60; el Compose sube `max_connections` a 400, pero con
 *   varias suites en paralelo conviene bajarlo a lo que la suite realmente usa).
 */
export async function createIsolatedDatabase(sqlFiles: readonly string[], options: IsolatedDatabaseOptions = {}): Promise<IsolatedDatabase> {
  const max = poolMax(options.max); // se valida ANTES de crear nada
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw new Error(
      `No se pudo conectar a la base de pruebas (${TEST_DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}). ` +
        `Levantala con \`docker compose -f platform/compose.yml up -d postgres\`. Causa: ${(error as Error).message}`,
    );
  }
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max });
  for (const file of sqlFiles) await pool.query(readFileSync(file, 'utf8'));
  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export * from './events';
export * from './openapi';
