import type { Pool } from 'pg';
import type { ColumnShape } from '../../src/persistence/schema-map';

export interface Drift {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Compara el esquema APLICADO en la base con el mapa que el código asume (regla 97.2). Detecta: tabla ausente, columna ausente,
 * tipo y nulabilidad divergentes, columna obligatoria (NOT NULL sin default) que el mapa no conoce, columna opcional que el mapa
 * no conoce y tabla sin mapear (solo las del servicio: las tablas técnicas de @pay/* se ignoran).
 */
export async function detectDrift(pool: Pool, map: Readonly<Record<string, Readonly<Record<string, ColumnShape>>>>, ignoredTables: readonly string[] = ['outbox_events', 'inbox_events', 'idempotency_keys']): Promise<Drift[]> {
  const drift: Drift[] = [];
  const columns = await pool.query(
    "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position",
  );
  const actual = new Map<string, Map<string, { type: string; nullable: boolean; hasDefault: boolean }>>();
  for (const r of columns.rows) {
    const table = actual.get(r.table_name as string) ?? new Map();
    table.set(r.column_name as string, { type: r.data_type as string, nullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null });
    actual.set(r.table_name as string, table);
  }
  for (const [table, expected] of Object.entries(map)) {
    const found = actual.get(table);
    if (!found) {
      drift.push({ kind: 'tabla_ausente', detail: table });
      continue;
    }
    for (const [name, shape] of Object.entries(expected)) {
      const col = found.get(name);
      if (!col) drift.push({ kind: 'columna_ausente', detail: `${table}.${name}` });
      else {
        if (col.type !== shape.type) drift.push({ kind: 'tipo_divergente', detail: `${table}.${name}: base ${col.type}, mapa ${shape.type}` });
        if (col.nullable !== shape.nullable) drift.push({ kind: 'nulabilidad_divergente', detail: `${table}.${name}: base ${col.nullable ? 'NULL' : 'NOT NULL'}, mapa ${shape.nullable ? 'NULL' : 'NOT NULL'}` });
      }
    }
    for (const [name, col] of found) {
      if (expected[name]) continue;
      drift.push({ kind: !col.nullable && !col.hasDefault ? 'columna_obligatoria_no_mapeada' : 'columna_sobrante_en_el_mapa', detail: `${table}.${name}` });
    }
  }
  for (const table of actual.keys()) if (!map[table] && !ignoredTables.includes(table)) drift.push({ kind: 'tabla_sin_mapear', detail: table });
  return drift;
}

/** Regla 97.3.2: todo índice se crea con nombre explícito. Un `CREATE INDEX ON …` deja que Postgres invente el nombre. */
export function detectUnnamedIndexes(sqlTexts: readonly string[]): Drift[] {
  return sqlTexts.flatMap((sql, i) => [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?ON\b[^;]*/gi)].map((m) => ({ kind: 'indice_sin_nombre_propio', detail: `archivo ${i}: ${m[0].slice(0, 60)}` })));
}
