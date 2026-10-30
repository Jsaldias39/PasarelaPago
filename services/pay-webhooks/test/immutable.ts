import type { Pool } from 'pg';

/**
 * Vaciado de PRUEBAS de una tabla de solo-agregar del modelo (guardián `<tabla>_immutable`, modelo ola-5/P2).
 * Apaga SOLO el trigger de esa tabla, borra y lo vuelve a armar DENTRO de una misma transacción: ninguna otra conexión ve el guardián apagado y, si algo
 * falla, el ROLLBACK lo deja armado. Es el mismo recurso que ya usa `pay-merchants/test/merchants-truncate.spec.ts` (`ALTER TABLE … DISABLE TRIGGER`, que
 * exige ser dueño de la tabla: lo es el rol de la base descartable de las pruebas). NO es un bypass del modelo ni existe en producción; solo se usa sobre
 * esquemas aislados que crea y borra `createIsolatedDatabase`.
 */
export async function deleteFromImmutable(pool: Pool, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`nombre de tabla inválido: ${table}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_immutable`);
    const res = await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_immutable`);
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
