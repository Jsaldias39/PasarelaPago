// PRUEBA NUEVA (revisión de seguridad 2026-10-28), propuesta para services/pay-connectors/test/:
//  · connector_charges.send_claims es MONÓTONO (como en transfers y refunds);
//  · `ambiguous` true -> false es LEGÍTIMO y se sigue permitiendo (lo resuelve un callback o una consulta autoritativa; apply.ts / charges.service.ts);
//  · los tres registros de dinero rechazan TRUNCATE.
import { createTestApp, type TestApp } from './support/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
const q = (sql: string, params: unknown[] = []) => t.db.pool.query(sql, params);
const insertCharge = (id: string) =>
  q(
    `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency, routing_version, expires_at, next_poll_at)
     VALUES ($1, 'pay-payments', $1, 'pi_' || substr($1, 4), 'mc_abcdefghij', 'test', 'mock', 'sandbox', 'qr', 100, 'BOB', 1, now() + interval '1 hour', now())`,
    [id],
  );

describe('connector_charges: send_claims monótono, ambiguous libre', () => {
  it('correcto: send_claims sube y `ambiguous` pasa true -> false (la resolución legítima de un cobro ambiguo)', async () => {
    await insertCharge('ch_monotono0001');
    await q(`UPDATE connector_charges SET ambiguous = true, send_claims = send_claims + 1 WHERE id = 'ch_monotono0001'`);
    await q(`UPDATE connector_charges SET ambiguous = false WHERE id = 'ch_monotono0001'`);
    const r = (await q(`SELECT ambiguous, send_claims FROM connector_charges WHERE id = 'ch_monotono0001'`)).rows[0];
    expect(r).toEqual({ ambiguous: false, send_claims: 1 });
  });

  it('límite: dejar send_claims igual y cambiar otras columnas está permitido; bajarlo en 1 no', async () => {
    await insertCharge('ch_monotono0002');
    await q(`UPDATE connector_charges SET send_claims = 2 WHERE id = 'ch_monotono0002'`);
    await q(`UPDATE connector_charges SET send_claims = 2, provider_status = 'authorized' WHERE id = 'ch_monotono0002'`);
    await expect(q(`UPDATE connector_charges SET send_claims = 1 WHERE id = 'ch_monotono0002'`)).rejects.toThrow(/send_claims es monotono/);
  });

  it('inválido: send_claims no puede volver a cero ni quedar negativo', async () => {
    await insertCharge('ch_monotono0003');
    await q(`UPDATE connector_charges SET send_claims = 5 WHERE id = 'ch_monotono0003'`);
    await expect(q(`UPDATE connector_charges SET send_claims = 0 WHERE id = 'ch_monotono0003'`)).rejects.toThrow(/send_claims es monotono/);
    await expect(q(`UPDATE connector_charges SET send_claims = -1 WHERE id = 'ch_monotono0003'`)).rejects.toThrow(/send_claims es monotono/);
  });
});

describe('TRUNCATE de los registros de dinero', () => {
  it('inválido: connector_charges (CASCADE), connector_transfers y connector_refunds rechazan TRUNCATE', async () => {
    await expect(q('TRUNCATE connector_charges CASCADE')).rejects.toThrow(/inmutable/);
    await expect(q('TRUNCATE connector_transfers')).rejects.toThrow(/inmutable/);
    await expect(q('TRUNCATE connector_refunds')).rejects.toThrow(/inmutable/);
  });
  it('límite: una tabla sin guardián (connector_health) se sigue pudiendo vaciar; DELETE no se prohíbe (el reset de las pruebas lo usa)', async () => {
    await expect(q('TRUNCATE connector_health')).resolves.toBeDefined();
    await expect(q(`DELETE FROM connector_charges WHERE id = 'ch_monotono0001'`)).resolves.toBeDefined();
  });
  it('correcto: INSERT y SELECT normales no se ven afectados', async () => {
    await insertCharge('ch_monotono0004');
    expect((await q(`SELECT count(*)::int AS n FROM connector_charges WHERE id = 'ch_monotono0004'`)).rows[0].n).toBe(1);
  });
});
