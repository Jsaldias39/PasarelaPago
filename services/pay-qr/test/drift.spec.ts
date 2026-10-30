import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { QR_SCHEMA_MAP } from '../src/schema-map';
import { detectDrift } from './support/drift';

// Deriva de esquema (97.2, P4.H1.M2): modelo (ddl.sql vendorizado) ↔ base aplicada ↔ mapa del código (src/schema-map.ts).
let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([join(process.cwd(), 'sql/ddl.sql')]);
});
afterAll(async () => db.drop());

describe('deriva modelo ↔ base ↔ mapa del código (P4.H1.M2, 97.2)', () => {
  it('sin deriva: la base que sale del ddl.sql del modelo coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, QR_SCHEMA_MAP)).toEqual([]);
  });

  it('el ddl.sql vendorizado coincide con el del modelo (scripts/vendor-ddl.sh --check; sin el repo hermano, se omite sin fallar)', () => {
    const out = execFileSync(join(process.cwd(), 'scripts/vendor-ddl.sh'), ['--check'], { encoding: 'utf8' });
    expect(out).toMatch(/coincide con el modelo|no está en .* omitido, sin falla/);
  });

  it('aplicar el ddl.sql DOS veces no cambia nada (idempotente) y deja los índices con nombre propio', async () => {
    const before = await detectDrift(db.pool, QR_SCHEMA_MAP);
    const { readFileSync } = await import('node:fs');
    await db.pool.query(readFileSync(join(process.cwd(), 'sql/ddl.sql'), 'utf8'));
    expect(await detectDrift(db.pool, QR_SCHEMA_MAP)).toEqual(before);
    const named = await db.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('qr_codes_reference_uidx', 'qr_codes_static_per_merchant_uidx', 'qr_codes_live_per_intent_uidx')`);
    expect(named.rows).toHaveLength(3); // los nombres que usa el código se conservan
  });

  describe('el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale): CONTROL NEGATIVO', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE qr_codes DROP COLUMN IF EXISTS extra_required');
      await db.pool.query('ALTER TABLE qr_codes DROP COLUMN IF EXISTS extra_optional');
    });

    it('columna obligatoria no mapeada (el modelo agrega una NOT NULL sin default que el código no llena)', async () => {
      await db.pool.query("ALTER TABLE qr_codes ADD COLUMN extra_required text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE qr_codes ALTER COLUMN extra_required DROP DEFAULT');
      expect(await detectDrift(db.pool, QR_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'qr_codes.extra_required' }]);
    });

    it('columna opcional que el mapa no conoce', async () => {
      await db.pool.query('ALTER TABLE qr_codes ADD COLUMN extra_optional text');
      expect((await detectDrift(db.pool, QR_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['columna_sobrante_en_el_mapa']);
    });

    it('MUTACIÓN DEL MAPA: tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...QR_SCHEMA_MAP,
        qr_fantasma: { id: { type: 'text', nullable: false } },
        qr_codes: { ...QR_SCHEMA_MAP.qr_codes, columna_fantasma: { type: 'text', nullable: false }, merchant_id: { type: 'integer', nullable: true } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(
        [
          'columna_ausente:qr_codes.columna_fantasma',
          'nulabilidad_divergente:qr_codes.merchant_id: base NOT NULL, mapa NULL',
          'tabla_ausente:qr_fantasma',
          'tipo_divergente:qr_codes.merchant_id: base text, mapa integer',
        ].sort(),
      );
    });

    it('MUTACIÓN DEL MAPA: quitar una columna que el código usa de verdad (amount_minor) hace fallar el «sin deriva»', async () => {
      const { amount_minor: _omitted, ...withoutAmount } = QR_SCHEMA_MAP.qr_codes as Record<string, unknown>;
      void _omitted;
      const drift = await detectDrift(db.pool, { ...QR_SCHEMA_MAP, qr_codes: withoutAmount as never });
      expect(drift.some((d) => d.detail.startsWith('qr_codes.amount_minor'))).toBe(true);
    });

    it('tabla sin mapear e índice con nombre generado', async () => {
      await db.pool.query('CREATE TABLE qr_nueva (id text PRIMARY KEY)');
      await db.pool.query('CREATE INDEX ON qr_codes (kind)');
      try {
        const kinds = (await detectDrift(db.pool, QR_SCHEMA_MAP)).map((d) => d.kind).sort();
        expect(kinds).toEqual(['indice_sin_nombre_propio', 'tabla_sin_mapear'].sort());
      } finally {
        await db.pool.query('DROP TABLE qr_nueva');
        await db.pool.query('DROP INDEX qr_codes_kind_idx');
      }
    });
  });
});
