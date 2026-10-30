import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { PAYMENTS_SCHEMA_MAP } from '../src/persistence/schema-map';
import { detectDrift, detectUnnamedIndexes } from './helpers/drift';
import { SQL_FILES } from './helpers/stack';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase(SQL_FILES);
});
afterAll(async () => db.drop());

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });

describe('deriva SQL ↔ base ↔ código (P3.H1.M2, regla 97.2)', () => {
  it('sin deriva: el SQL aplicado coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, PAYMENTS_SCHEMA_MAP)).toEqual([]);
  });

  it('todo INSERT del código nombra solo columnas que existen y cubre TODA columna obligatoria sin valor por defecto (independiente del mapa)', async () => {
    const required = await db.pool.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_nullable = 'NO' AND column_default IS NULL",
    );
    const needs = new Map<string, Set<string>>();
    for (const r of required.rows) (needs.get(r.table_name) ?? needs.set(r.table_name, new Set()).get(r.table_name)!).add(r.column_name);
    const text = sources(path.join(process.cwd(), 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const inserts = [...text.matchAll(/INSERT INTO (\w+)\s*\(([^)]*)\)/g)].map((m) => ({ table: m[1] as string, columns: (m[2] as string).split(',').map((c) => c.trim()) }));
    const covered = new Map<string, Set<string>>();
    for (const { table, columns } of inserts) {
      if (['outbox_events', 'inbox_events', 'idempotency_keys'].includes(table)) continue;
      const known = new Set(Object.keys(PAYMENTS_SCHEMA_MAP[table] ?? {}));
      expect({ table, desconocidas: columns.filter((c) => !known.has(c)) }).toEqual({ table, desconocidas: [] });
      const set = covered.get(table) ?? new Set<string>();
      for (const c of columns) set.add(c);
      covered.set(table, set);
    }
    // `bigserial` (id) y `now()` tienen default; lo que queda como obligatorio sin default tiene que escribirlo algún INSERT.
    const missing: string[] = [];
    for (const [table, set] of needs) {
      if (!covered.has(table)) continue; // tablas sin INSERT en src (ninguna hoy): las cubre el chequeo de arriba
      for (const column of set) if (!covered.get(table)!.has(column)) missing.push(`${table}.${column}`);
    }
    expect(missing).toEqual([]);
    expect([...covered.keys()].sort()).toEqual(['disputes', 'fee_schedule_replica', 'intent_contradictions', 'merchant_replica', 'payment_cancellation_requests', 'payment_intents', 'refunds', 'wallet_authorizations_used']);
  });

  describe('el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale)', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE refunds DROP COLUMN IF EXISTS extra_required');
      await db.pool.query('ALTER TABLE refunds DROP COLUMN IF EXISTS extra_optional');
    });

    it('columna obligatoria no mapeada', async () => {
      await db.pool.query("ALTER TABLE refunds ADD COLUMN extra_required text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE refunds ALTER COLUMN extra_required DROP DEFAULT');
      expect(await detectDrift(db.pool, PAYMENTS_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'refunds.extra_required' }]);
    });

    it('columna opcional que el mapa no conoce', async () => {
      await db.pool.query('ALTER TABLE refunds ADD COLUMN extra_optional text');
      expect((await detectDrift(db.pool, PAYMENTS_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['columna_sobrante_en_el_mapa']);
    });

    it('tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...PAYMENTS_SCHEMA_MAP,
        fantasma: { id: { type: 'text', nullable: false } },
        refunds: { ...PAYMENTS_SCHEMA_MAP.refunds, columna_fantasma: { type: 'text', nullable: false }, reason: { type: 'integer', nullable: false } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(
        ['columna_ausente:refunds.columna_fantasma', 'nulabilidad_divergente:refunds.reason: base NULL, mapa NOT NULL', 'tabla_ausente:fantasma', 'tipo_divergente:refunds.reason: base text, mapa integer'].sort(),
      );
    });

    it('tabla sin mapear', async () => {
      await db.pool.query('CREATE TABLE tabla_nueva (id text PRIMARY KEY, valor text)');
      try {
        expect((await detectDrift(db.pool, PAYMENTS_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['tabla_sin_mapear']);
      } finally {
        await db.pool.query('DROP TABLE tabla_nueva');
      }
    });

    it('índice sin nombre explícito (regla 97.3.2)', () => {
      expect(detectUnnamedIndexes(SQL_FILES.map((f) => readFileSync(f, 'utf8')))).toEqual([]);
      expect(detectUnnamedIndexes(['CREATE INDEX ON t (c);', 'CREATE UNIQUE INDEX IF NOT EXISTS ON t (c);', 'CREATE INDEX t_c_idx ON t (c);']).map((d) => d.kind)).toEqual(['indice_sin_nombre_propio', 'indice_sin_nombre_propio']);
    });
  });
});
