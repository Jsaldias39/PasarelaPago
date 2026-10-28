// PRUEBA NUEVA (revisión de seguridad 2026-10-28), propuesta para services/pay-merchants/test/: TRUNCATE rechazado en TODAS las tablas inmutables.
// El trigger BEFORE TRUNCATE dispara también para el dueño de la tabla y para el superusuario (el pool de pruebas es superusuario).
import { createTestContext, type TestContext } from './support/app';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
const q = (sql: string) => ctx.db.pool.query(sql);

describe('TRUNCATE de las tablas inmutables de pay-merchants', () => {
  it('inválido: las cuatro tablas inmutables rechazan TRUNCATE aunque el guardián de sus hijos esté apagado (cada una tiene el suyo)', async () => {
    for (const table of ['contract_versions', 'contract_acceptances', 'fee_schedule_versions', 'fee_schedule_channels']) {
      const children = ['contract_acceptances', 'fee_schedule_channels', 'fee_schedule_versions'].filter((t) => t !== table);
      for (const child of children) await q(`ALTER TABLE ${child} DISABLE TRIGGER USER`);
      try {
        await expect(q(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/inmutable/);
      } finally {
        for (const child of children) await q(`ALTER TABLE ${child} ENABLE TRIGGER USER`);
      }
    }
  });

  it('límite: una tabla que NO es inmutable (api_keys) se sigue pudiendo vaciar; el TRUNCATE de la tabla padre `merchants` a secas lo frena la FK', async () => {
    await expect(q('TRUNCATE api_keys')).resolves.toBeDefined();
    await expect(q('TRUNCATE merchants')).rejects.toThrow(/foreign key|truncate a table referenced/i);
  });

  it('correcto: INSERT sigue permitido en las inmutables (solo se agrega) y UPDATE/DELETE siguen rechazados', async () => {
    await q(`INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (900, repeat('a', 64), now(), 'sintetico')`);
    await expect(q(`UPDATE contract_versions SET published_by = 'otro' WHERE version = 900`)).rejects.toThrow(/inmutable/);
    await expect(q('DELETE FROM contract_versions WHERE version = 900')).rejects.toThrow(/inmutable/);
  });
});
