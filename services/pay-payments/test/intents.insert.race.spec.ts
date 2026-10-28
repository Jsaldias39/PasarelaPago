import { randomBytes } from 'node:crypto';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { intentsRepo, type NewIntent } from '../src/persistence/intents.repo';
import { SQL_FILES } from './helpers/stack';

/**
 * Tanda 3c · clasificación de la falla intermitente de `internal.api.spec.ts` (10 POST concurrentes del mismo mandato y periodo).
 * Evidencia de la corrida que falló: el filtro de errores registró `code: '23505'` (unique_violation) y devolvió 500 a una de las peticiones.
 * Causa: `payment_intents` tiene DOS índices únicos que el mismo intento puede violar (la clave primaria `id` y `payment_intents_mandate_period_uidx`)
 * y el `INSERT … ON CONFLICT (id) DO NOTHING` solo arbitra el primero: si dos transacciones insertan a la vez la misma fila, una puede chocar con el
 * índice del mandato y Postgres lanza 23505 en vez de ignorarla. El arreglo es `ON CONFLICT DO NOTHING` (sin objetivo): cualquier choque único es «ya existe».
 */
let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase(SQL_FILES);
}, 60_000);
afterAll(async () => db.drop());

const base = (id: string, source: NewIntent['source']): NewIntent => ({
  id, merchantId: 'mc_merchant00001', mode: 'test', amountMinor: 30000, method: 'wallet', feeMinor: 0, netMinor: 30000, metadata: {},
  expiresAt: new Date(Date.now() + 3600_000), source, kind: 'obligation', beneficiaryMerchantId: 'mc_merchant00002',
});
const attempt = async (intent: NewIntent): Promise<'inserted' | 'exists' | string> => {
  try {
    return (await intentsRepo.insert(db.pool, intent)).inserted ? 'inserted' : 'exists';
  } catch (error) {
    return `error:${(error as { code?: string }).code ?? (error as Error).name}`;
  }
};

describe('insert concurrente del MISMO intento por mandato (3c)', () => {
  it('correcto · 12 inserciones simultáneas del mismo intento: UNA inserta, el resto «ya existe», ningún error (repetido 60 rondas)', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 60; round += 1) {
      const mandate = `md_${randomBytes(6).toString('hex')}`;
      const id = `pi_${randomBytes(10).toString('hex')}`;
      const results = await Promise.all(Array.from({ length: 12 }, () => attempt(base(id, { kind: 'mandate', id: mandate, period: '2026-12' }))));
      outcomes.push(...results);
      expect(results.filter((r) => r === 'inserted')).toHaveLength(1);
    }
    expect(outcomes.filter((r) => r.startsWith('error'))).toEqual([]);
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM payment_intents');
    expect(rows.rows[0].n).toBe(60);
  });

  it('límite · mismo mandato y periodo con OTRO id (otro pagador): no se inserta una segunda fila y tampoco es un error 500 (la base conserva una sola)', async () => {
    const mandate = `md_${randomBytes(6).toString('hex')}`;
    const source = { kind: 'mandate' as const, id: mandate, period: '2027-01' };
    const results = await Promise.all([attempt(base(`pi_${randomBytes(10).toString('hex')}`, source)), attempt(base(`pi_${randomBytes(10).toString('hex')}`, source))]);
    expect(results.filter((r) => r === 'inserted')).toHaveLength(1);
    expect(results.filter((r) => r.startsWith('error'))).toEqual([]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM payment_intents WHERE source ->> 'id' = $1", [mandate])).rows[0].n).toBe(1);
  });

  it('inválido · una violación que NO es de unicidad sigue siendo un error (no se traga todo): modo fuera del catálogo / columna obligatoria nula', async () => {
    const bad = await attempt({ ...base(`pi_${randomBytes(10).toString('hex')}`, null), amountMinor: null as never });
    expect(bad).toMatch(/^error:/);
    expect(bad).not.toBe('error:23505');
  });
});
