// Constraint nuevo del modelo (commit af60b79, INTEGRACION.md §7.2): `ledger_holds` referencia a `ledger_accounts` como las patas (FK compuestas por modo).
// Tres niveles: correcto (el servicio registra las cuentas antes de la retención, aceptada o rechazada), límite (cuentas de OTRO modo / solo una de las dos),
// inválido (SQL directo con cuentas que no existen; y que el servicio nunca responda 500 por el constraint). Adaptada de la propuesta del agente del modelo.
import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId } from './helpers/app';

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code: string) => ({ debit_account, credit_account, amount_minor, code });
async function tx(legs: object[], caller: string) {
  const res = await ctx.as(caller).post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs }).set('idempotency-key', key());
  expect(res.status).toBe(201);
}
async function fund(m: string, amount: number) {
  await tx([leg(CLEARING, `merchant:${m}:pending`, amount, 'charge')], 'pay-payments');
  await tx([leg(`merchant:${m}:pending`, `merchant:${m}:available`, amount, 'release')], 'pay-settlement');
}
const holdBody = (m: string, amount: number) => ({ business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: amount, currency: 'BOB', expires_in_seconds: 60 });
const createHold = async (payload: object) => checked(ctx, 'POST', '/holds', await ctx.as('pay-settlement').post('/holds', payload).set('idempotency-key', key()));
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;
const insertHold = (mode: string, debit: string, credit: string) =>
  ctx.db.pool.query(
    `INSERT INTO ledger_holds (id, mode, business_ref, attempt, content_hash, status, debit_account, credit_account, amount_minor, currency, expires_at)
     VALUES ($1, $2, $3, 1, repeat('a', 64), 'pending', $4, $5, 1, 'BOB', now() + interval '1 minute')`,
    [`hd_${Math.random().toString(36).slice(2, 14)}`, mode, businessRef('fk'), debit, credit],
  );

describe('ledger_holds → ledger_accounts (FK compuestas por modo)', () => {
  it('correcto: el servicio registra las dos cuentas ANTES de la retención, aceptada o rechazada', async () => {
    const m = merchantId();
    await fund(m, 1000);
    const ok = await createHold(holdBody(m, 400));
    expect(ok.status).toBe(201);
    const rejected = await createHold({ ...holdBody(m, 5_000_000), business_ref: businessRef('payout') });
    expect(rejected.status).toBe(422);
    const found = await rows(
      `SELECT h.status FROM ledger_holds h
         JOIN ledger_accounts d ON d.mode = h.mode AND d.account = h.debit_account
         JOIN ledger_accounts c ON c.mode = h.mode AND c.account = h.credit_account
        WHERE h.debit_account = $1 ORDER BY h.status`,
      [`merchant:${m}:available`],
    );
    expect(found.map((r) => r.status)).toEqual(['pending', 'rejected']);
  });

  it('inválido (por la API): una retención rechazada sobre un comercio que NUNCA operó registra sus cuentas y responde 422 limpio, sin 500 ni fila huérfana', async () => {
    const m = merchantId(); // sin ningún movimiento: sus cuentas no existen todavía ni en Postgres ni en TigerBeetle
    const payload = holdBody(m, 100);
    const res = await createHold(payload);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_funds');
    const registered = await rows('SELECT account FROM ledger_accounts WHERE mode = $1 AND account = ANY($2) ORDER BY account', ['test', [`merchant:${m}:available`, 'payout:clearing']]);
    expect(registered.map((r) => r.account)).toEqual([`merchant:${m}:available`, 'payout:clearing']);
    const held = await rows('SELECT status, reject_code FROM ledger_holds WHERE business_ref = $1', [payload.business_ref]);
    expect(held).toEqual([{ status: 'rejected', reject_code: expect.any(String) }]);
  });

  it('inválido (por la API): cuentas con forma inválida o inexistente en el plan se rechazan con 422 de validación ANTES de tocar la base; el constraint nunca se alcanza', async () => {
    for (const debit_account of ['merchant:no-es-un-id:available', 'cuenta-inventada', 'merchant:mc_abcdef123456k3m9:pending:extra']) {
      const res = await createHold({ ...holdBody(merchantId(), 1), debit_account });
      expect([400, 422]).toContain(res.status);
      expect(res.status).not.toBe(500);
    }
    expect((await rows("SELECT count(*)::int AS n FROM ledger_holds WHERE debit_account IN ('cuenta-inventada', 'merchant:no-es-un-id:available')"))[0].n).toBe(0);
  });

  it('la reintentada del mismo (business_ref, attempt) tras el rechazo converge: no duplica ni falla por el constraint', async () => {
    const m = merchantId();
    const payload = holdBody(m, 100);
    expect((await createHold(payload)).status).toBe(422);
    expect([200, 422]).toContain((await createHold(payload)).status);
    expect((await rows('SELECT count(*)::int AS n FROM ledger_holds WHERE business_ref = $1', [payload.business_ref]))[0].n).toBe(1);
  });

  it('límite: las cuentas existen solo en `test`; una retención en `live` o con una sola de las dos registrada se rechaza', async () => {
    const m = merchantId();
    await fund(m, 100);
    const debit = `merchant:${m}:available`;
    await expect(insertHold('live', debit, 'payout:clearing')).rejects.toThrow(/foreign key|violates/i);
    await expect(insertHold('test', debit, `merchant:${m}:no-registrada`)).rejects.toThrow(/foreign key|violates/i);
    await expect(insertHold('test', `merchant:${m}:no-registrada`, 'payout:clearing')).rejects.toThrow(/foreign key|violates/i);
    await expect(insertHold('test', debit, 'payout:clearing')).resolves.toBeDefined();
  });

  it('inválido: una retención con cuentas que no existen en ninguna parte no entra', async () => {
    await expect(insertHold('test', `merchant:${merchantId()}:fantasma`, 'payout:fantasma')).rejects.toThrow(/foreign key|violates/i);
  });
});
