import { readFileSync } from 'node:fs';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { VAULT_SCHEMA_MAP } from '../src/vault/schema-map';
import { detectDrift, detectUnnamedIndexes } from './helpers/drift';
import { SQL_FILES } from './helpers/app';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase(SQL_FILES);
});
afterAll(async () => db.drop());

describe('deriva SQL ↔ base ↔ código (P3.H3.M2, regla 97.2)', () => {
  it('sin deriva: el SQL aplicado coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, VAULT_SCHEMA_MAP)).toEqual([]);
  });

  it('ninguna columna de ninguna tabla puede ser un dato de tarjeta (nombres vedados)', () => {
    const forbidden = /^(pan|number|card_number|cvv|cvc|holder_name|holder|cardholder|track\d?|pin|exp)$/i;
    const offenders = Object.entries(VAULT_SCHEMA_MAP).flatMap(([table, cols]) => Object.keys(cols).filter((c) => forbidden.test(c)).map((c) => `${table}.${c}`));
    expect(offenders).toEqual([]);
    // Lo único de la tarjeta que se guarda: marca, últimos 4, vencimiento y huella opaca.
    expect(Object.keys(VAULT_SCHEMA_MAP.card_tokens)).toEqual(expect.arrayContaining(['brand', 'last4', 'exp_month', 'exp_year', 'fingerprint']));
  });

  it('todo índice del SQL tiene nombre explícito (regla 97.3.2)', () => {
    expect(detectUnnamedIndexes(SQL_FILES.map((f) => readFileSync(f, 'utf8')))).toEqual([]);
    expect(detectUnnamedIndexes(['CREATE INDEX ON t (c);']).map((d) => d.kind)).toEqual(['indice_sin_nombre_propio']);
  });

  describe('el verificador detecta la deriva', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE card_tokens DROP COLUMN IF EXISTS pan');
    });
    it('una columna nueva (por ejemplo, un PAN) se ve como deriva', async () => {
      await db.pool.query("ALTER TABLE card_tokens ADD COLUMN pan text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE card_tokens ALTER COLUMN pan DROP DEFAULT');
      expect(await detectDrift(db.pool, VAULT_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'card_tokens.pan' }]);
    });
    it('tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...VAULT_SCHEMA_MAP,
        fantasma: { id: { type: 'text', nullable: false } },
        card_tokens: { ...VAULT_SCHEMA_MAP.card_tokens, columna_fantasma: { type: 'text', nullable: false }, last4: { type: 'integer', nullable: true } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(['columna_ausente:card_tokens.columna_fantasma', 'nulabilidad_divergente:card_tokens.last4: base NOT NULL, mapa NULL', 'tabla_ausente:fantasma', 'tipo_divergente:card_tokens.last4: base text, mapa integer'].sort());
    });
  });
});
