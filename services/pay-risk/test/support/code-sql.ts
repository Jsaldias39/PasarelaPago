import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Lo que el código nombra en sus sentencias SQL literales. Extracción estática: INSERT (tabla + columnas), UPDATE … SET (tabla + columnas) y FROM/JOIN (tablas). */
export interface CodeSql {
  readonly inserts: { file: string; table: string; columns: string[] }[];
  readonly updates: { file: string; table: string; columns: string[] }[];
  readonly tables: { file: string; table: string }[];
}

const NOT_TABLES = new Set(['select', 'information_schema', 'unnest', 'generate_series', 'lateral', 'only', 'now', 'jsonb_array_elements']);

export function extractSql(file: string, text: string): CodeSql {
  const inserts: CodeSql['inserts'] = [];
  const updates: CodeSql['updates'] = [];
  const tables: CodeSql['tables'] = [];
  for (const m of text.matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
    inserts.push({ file, table: m[1]!, columns: m[2]!.split(',').map((c) => c.trim()).filter(Boolean) });
  }
  for (const m of text.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|\s+RETURNING\b|`|"|')/gi)) {
    const table = m[1]!;
    if (!/^[a-z_]+$/.test(table) || ['set', 'only'].includes(table.toLowerCase())) continue;
    let depth = 0;
    let current = '';
    const parts: string[] = [];
    for (const ch of m[2]!) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else current += ch;
    }
    parts.push(current);
    updates.push({ file, table, columns: parts.map((p) => /^\s*(\w+)\s*=/.exec(p)?.[1]).filter((c): c is string => c !== undefined) });
  }
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\b/g)) {
    const table = m[1]!;
    if (NOT_TABLES.has(table) || table.startsWith('pg_') || table.startsWith('jsonb')) continue;
    // Sólo dentro de literales SQL: evita palabras de comentarios («de la tabla …»).
    const lineStart = text.lastIndexOf('\n', m.index);
    if (/\/\/|\*\s/.test(text.slice(lineStart, m.index))) continue;
    if (!/(SELECT|DELETE|UPDATE|EXISTS|WITH|USING|\()[\s\S]*$/i.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
    tables.push({ file, table });
  }
  return { inserts, updates, tables };
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.spec.ts')) yield p;
  }
}

/** Todo el SQL literal del código del servicio (`src/`), sin los tests. */
export function codeSql(srcDir: string): CodeSql {
  const all: CodeSql = { inserts: [], updates: [], tables: [] };
  for (const file of walk(srcDir)) {
    const part = extractSql(file, readFileSync(file, 'utf8'));
    all.inserts.push(...part.inserts);
    all.updates.push(...part.updates);
    all.tables.push(...part.tables);
  }
  return all;
}
