import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { CONNECTORS_SCHEMA_MAP } from '../src/schema-map';
import { detectDrift } from './support/drift';

// Deriva de esquema (97.2, P4.H1.M2): modelo (ddl.sql vendorizado) ↔ base aplicada ↔ mapa del código (src/schema-map.ts).
let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([join(process.cwd(), 'sql/ddl.sql')]);
});
afterAll(async () => db.drop());

describe('deriva modelo ↔ base ↔ mapa del código (P4.H1.M2, 97.2)', () => {
  it('sin deriva: la base que sale del ddl.sql del modelo coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP)).toEqual([]);
  });

  it('el ddl.sql vendorizado coincide con el del modelo (scripts/vendor-ddl.sh --check; sin el repo hermano, se omite sin fallar)', () => {
    const out = execFileSync(join(process.cwd(), 'scripts/vendor-ddl.sh'), ['--check'], { encoding: 'utf8' });
    expect(out).toMatch(/coincide con el modelo|no está en .* omitido, sin falla/);
  });

  it('aplicar el ddl.sql DOS veces no cambia nada (idempotente) y deja los índices con nombre propio', async () => {
    const before = await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP);
    const { readFileSync } = await import('node:fs');
    await db.pool.query(readFileSync(join(process.cwd(), 'sql/ddl.sql'), 'utf8'));
    expect(await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP)).toEqual(before);
    const named = await db.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('connector_charges_live_intent_uidx', 'connector_refunds_refund_id_uidx')`);
    expect(named.rows).toHaveLength(2); // los nombres que usa el código se conservan
  });

  describe('el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale): CONTROL NEGATIVO', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE connector_health DROP COLUMN IF EXISTS extra_required');
      await db.pool.query('ALTER TABLE connector_health DROP COLUMN IF EXISTS extra_optional');
    });

    it('columna obligatoria no mapeada (el modelo agrega una NOT NULL sin default que el código no llena)', async () => {
      await db.pool.query("ALTER TABLE connector_health ADD COLUMN extra_required text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE connector_health ALTER COLUMN extra_required DROP DEFAULT');
      expect(await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'connector_health.extra_required' }]);
    });

    it('columna opcional que el mapa no conoce', async () => {
      await db.pool.query('ALTER TABLE connector_health ADD COLUMN extra_optional text');
      expect((await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['columna_sobrante_en_el_mapa']);
    });

    it('MUTACIÓN DEL MAPA: tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...CONNECTORS_SCHEMA_MAP,
        connector_fantasma: { id: { type: 'text', nullable: false } },
        connector_charges: { ...CONNECTORS_SCHEMA_MAP.connector_charges, columna_fantasma: { type: 'text', nullable: false }, caller: { type: 'integer', nullable: true } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(
        [
          'columna_ausente:connector_charges.columna_fantasma',
          'nulabilidad_divergente:connector_charges.caller: base NOT NULL, mapa NULL',
          'tabla_ausente:connector_fantasma',
          'tipo_divergente:connector_charges.caller: base text, mapa integer',
        ].sort(),
      );
    });

    it('MUTACIÓN DEL MAPA: quitar una columna que el código usa de verdad (amount_minor) hace fallar el «sin deriva»', async () => {
      const { amount_minor: _omitted, ...withoutAmount } = CONNECTORS_SCHEMA_MAP.connector_charges as Record<string, unknown>;
      void _omitted;
      const drift = await detectDrift(db.pool, { ...CONNECTORS_SCHEMA_MAP, connector_charges: withoutAmount as never });
      expect(drift.some((d) => d.detail.startsWith('connector_charges.amount_minor'))).toBe(true);
    });

    it('tabla sin mapear e índice con nombre generado', async () => {
      await db.pool.query('CREATE TABLE connector_nueva (id text PRIMARY KEY)');
      await db.pool.query('CREATE INDEX ON connector_health (status)');
      try {
        const kinds = (await detectDrift(db.pool, CONNECTORS_SCHEMA_MAP)).map((d) => d.kind).sort();
        expect(kinds).toEqual(['indice_sin_nombre_propio', 'tabla_sin_mapear'].sort());
      } finally {
        await db.pool.query('DROP TABLE connector_nueva');
        await db.pool.query('DROP INDEX connector_health_status_idx');
      }
    });
  });
});
