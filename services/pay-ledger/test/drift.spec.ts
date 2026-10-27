import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { LEDGER_SCHEMA_MAP } from '../src/ledger/schema-map';
import { detectDrift } from './helpers/drift';
import { repoPath } from './helpers/app';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([
    repoPath('services/pay-ledger/sql/001_ledger.sql'),
    repoPath('contracts/packages/outbox/sql/001_outbox_inbox.sql'),
    repoPath('contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  ]);
});
afterAll(async () => db.drop());

describe('deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2)', () => {
  it('sin deriva: el SQL aplicado coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, LEDGER_SCHEMA_MAP)).toEqual([]);
  });

  describe('el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale)', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE ledger_rejections DROP COLUMN IF EXISTS extra_required');
      await db.pool.query('ALTER TABLE ledger_rejections DROP COLUMN IF EXISTS extra_optional');
    });

    it('columna obligatoria no mapeada', async () => {
      await db.pool.query("ALTER TABLE ledger_rejections ADD COLUMN extra_required text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE ledger_rejections ALTER COLUMN extra_required DROP DEFAULT');
      expect(await detectDrift(db.pool, LEDGER_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'ledger_rejections.extra_required' }]);
    });

    it('columna opcional que el mapa no conoce', async () => {
      await db.pool.query('ALTER TABLE ledger_rejections ADD COLUMN extra_optional text');
      expect((await detectDrift(db.pool, LEDGER_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['columna_sobrante_en_el_mapa']);
    });

    it('tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...LEDGER_SCHEMA_MAP,
        ledger_fantasma: { id: { type: 'text', nullable: false } },
        ledger_rejections: { ...LEDGER_SCHEMA_MAP.ledger_rejections, columna_fantasma: { type: 'text', nullable: false }, caller: { type: 'integer', nullable: true } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(
        [
          'columna_ausente:ledger_rejections.columna_fantasma',
          'nulabilidad_divergente:ledger_rejections.caller: base NOT NULL, mapa NULL',
          'tabla_ausente:ledger_fantasma',
          'tipo_divergente:ledger_rejections.caller: base text, mapa integer',
        ].sort(),
      );
    });

    it('tabla sin mapear e índice con nombre generado', async () => {
      await db.pool.query('CREATE TABLE ledger_nueva (id text PRIMARY KEY)');
      await db.pool.query('CREATE INDEX ON ledger_rejections (caller)');
      try {
        const kinds = (await detectDrift(db.pool, LEDGER_SCHEMA_MAP)).map((d) => d.kind).sort();
        expect(kinds).toEqual(['indice_sin_nombre_propio', 'tabla_sin_mapear'].sort());
      } finally {
        await db.pool.query('DROP TABLE ledger_nueva');
        await db.pool.query('DROP INDEX ledger_rejections_caller_idx');
      }
    });
  });
});
