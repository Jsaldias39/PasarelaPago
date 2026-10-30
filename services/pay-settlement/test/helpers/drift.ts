import type { Pool } from 'pg';
import type { ColumnMap } from '../../src/settlement/schema-map';

export interface Drift {
  readonly kind: 'tabla_ausente' | 'columna_ausente' | 'columna_obligatoria_no_mapeada' | 'columna_sobrante_en_el_mapa' | 'tipo_divergente' | 'nulabilidad_divergente' | 'tabla_sin_mapear' | 'indice_sin_nombre_propio';
  readonly detail: string;
}

/**
 * Verificación de deriva (97.2): fuente de verdad (el SQL aplicado) ↔ base ↔ mapa del código.
 * Mínimo exigido: tabla ausente, columna ausente, columna obligatoria no mapeada y nulabilidad divergente. Además: tipo, tablas sin mapear
 * (menos las técnicas de `@pay/outbox` / `@pay/idempotency`) e índices con el nombre que inventa Postgres (97.3.2: nombres explícitos).
 */
export async function detectDrift(
  pool: Pool,
  map: Readonly<Record<string, Readonly<Record<string, ColumnMap>>>>,
  technicalTables: readonly string[] = ['outbox_events', 'inbox_events', 'idempotency_keys'],
): Promise<Drift[]> {
  const columns = await pool.query<{ t: string; c: string; d: string; n: string; df: string | null }>(
    `SELECT table_name t, column_name c, data_type d, is_nullable n, column_default df
       FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const live = new Map<string, Map<string, { type: string; nullable: boolean; hasDefault: boolean }>>();
  for (const r of columns.rows) {
    const table = live.get(r.t) ?? new Map();
    table.set(r.c, { type: r.d, nullable: r.n === 'YES', hasDefault: r.df !== null });
    live.set(r.t, table);
  }
  const drift: Drift[] = [];
  for (const [table, cols] of Object.entries(map)) {
    const real = live.get(table);
    if (!real) {
      drift.push({ kind: 'tabla_ausente', detail: table });
      continue;
    }
    for (const [name, expected] of Object.entries(cols)) {
      const actual = real.get(name);
      if (!actual) {
        drift.push({ kind: 'columna_ausente', detail: `${table}.${name}` });
        continue;
      }
      if (actual.type !== expected.type) drift.push({ kind: 'tipo_divergente', detail: `${table}.${name}: base ${actual.type}, mapa ${expected.type}` });
      if (actual.nullable !== expected.nullable) drift.push({ kind: 'nulabilidad_divergente', detail: `${table}.${name}: base ${actual.nullable ? 'NULL' : 'NOT NULL'}, mapa ${expected.nullable ? 'NULL' : 'NOT NULL'}` });
    }
    for (const [name, actual] of real) {
      if (cols[name]) continue;
      drift.push(actual.nullable || actual.hasDefault ? { kind: 'columna_sobrante_en_el_mapa', detail: `${table}.${name} existe en la base y no está en el mapa` } : { kind: 'columna_obligatoria_no_mapeada', detail: `${table}.${name}` });
    }
  }
  for (const table of live.keys()) {
    if (!map[table] && !technicalTables.includes(table)) drift.push({ kind: 'tabla_sin_mapear', detail: table });
  }
  // Un nombre explícito no es el que Postgres inventa: `<tabla>_<columnas>_idx|key` (los *_pkey se aceptan: los fija la restricción).
  const indexes = await pool.query<{ t: string; i: string; cols: string[] }>(
    `SELECT t.relname t, i.relname i, array_agg(a.attname::text ORDER BY k.ord) cols
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = current_schema()
       JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      GROUP BY t.relname, i.relname`,
  );
  for (const { t, i, cols } of indexes.rows) {
    if (!map[t]) continue;
    const generated = [`${t}_${cols.join('_')}_idx`, `${t}_${cols.join('_')}_key`].map((name) => name.slice(0, 63));
    if (generated.includes(i)) drift.push({ kind: 'indice_sin_nombre_propio', detail: `${t}: ${i}` });
  }
  return drift;
}
