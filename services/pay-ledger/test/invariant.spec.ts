import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { type LedgerTestContext, businessRef, createLedgerContext, merchantId } from './helpers/app';
import { deleteFromImmutable } from './helpers/immutable';
import { waitFor } from './helpers/wait';
import { useIdNamespace } from '../src/ledger/ids';

// El invariante suma TODAS las cuentas del esquema de esta suite; las de plataforma (platform:fees, payout:clearing…) tienen nombre fijo y
// TigerBeetle es compartido, así que esta suite usa sus propios ids de cuenta y no hereda el saldo de las demás.
useIdNamespace(`invariante-${Math.random().toString(36).slice(2, 10)}`);

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const tx = (legs: object[], caller = 'pay-payments') =>
  ctx.as(caller).post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs }).set('idempotency-key', key());
const leg = (debit_account: string, credit_account: string, amount_minor: number, code: string) => ({ debit_account, credit_account, amount_minor, code });

describe('invariante global (REQ-P2-4)', () => {
  it('con actividad real (cobros, liberación, retención pendiente, retención confirmada, rechazos) débitos = créditos y TigerBeetle coincide con el extracto', async () => {
    const m = merchantId();
    await tx([leg(CLEARING, `merchant:${m}:pending`, 9700, 'charge'), leg(CLEARING, 'platform:fees', 300, 'fee')]);
    await tx([leg(`merchant:${m}:pending`, `merchant:${m}:available`, 9700, 'release')], 'pay-settlement');
    const hold = (amount: number) =>
      ctx.as('pay-settlement').post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: amount, currency: 'BOB', expires_in_seconds: 300 }).set('idempotency-key', key());
    const h1 = await hold(2000);
    await ctx.as('pay-settlement').post(`/holds/${h1.body.id}/post`).set('idempotency-key', key());
    await hold(1000); // queda pendiente
    expect((await hold(999_999)).status).toBe(422); // rechazo
    expect((await tx([leg(`merchant:${m}:available`, 'payout:clearing', 99_999_999, 'payout')], 'pay-settlement')).status).toBe(422);

    const report = await ctx.invariant.check();
    expect(report.mismatches).toEqual([]);
    expect(report.totalDebitsPosted).toBe(report.totalCreditsPosted);
    expect(report.totalDebitsPending).toBe(report.totalCreditsPending);
    expect(BigInt(report.totalDebitsPending)).toBeGreaterThanOrEqual(1000n);
    expect(report.accounts).toBeGreaterThanOrEqual(5);
    expect(report.ok).toBe(true);
  });

  it('se rompe a propósito: si falta una línea de extracto, el job lo detecta, lo registra como error y lo deja en `last`', async () => {
    const m = merchantId();
    await tx([leg(CLEARING, `merchant:${m}:pending`, 4242, 'charge')]);
    expect((await ctx.invariant.check()).ok).toBe(true);
    // corrupción: se borra de Postgres una línea de extracto (los metadatos se despegan del dinero)
    // `ledger_statement_lines` es de solo-agregar en el modelo (guardián `ledger_statement_lines_immutable`, ola-5/P2): la corrupción deliberada de la prueba apaga SOLO ese trigger,
    // dentro de una transacción y en el esquema aislado de la prueba (helpers/immutable.ts). El guardián vuelve a quedar armado al terminar.
    await deleteFromImmutable(ctx.db.pool, 'ledger_statement_lines', "account = $1 AND direction = 'credit'", [`merchant:${m}:pending`]);
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const report = await ctx.invariant.check();
    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual([{ mode: 'test', account: `merchant:${m}:pending`, field: 'credits_posted', tigerbeetle: '4242', postgres: '0' }]);
    expect(ctx.invariant.last).toBe(report);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls[0])).toContain('INVARIANTE DEL LEDGER ROTO');
    logged.mockRestore();
    // se restaura para que el resto de las pruebas del archivo (y el invariante global) no queden rotos
    await ctx.db.pool.query(
      `INSERT INTO ledger_statement_lines (id, mode, account, leg_id, business_ref, attempt, leg_index, direction, counterparty_account, amount_minor, code, posted_at)
       SELECT 'sl_restaurada' || substr(md5(random()::text), 1, 8), l.mode, $1, l.id, l.business_ref, l.attempt, l.leg_index, 'credit', l.debit_account, l.amount_minor, l.code, l.posted_at
         FROM ledger_legs l WHERE l.credit_account = $1`,
      [`merchant:${m}:pending`],
    );
    expect((await ctx.invariant.check()).ok).toBe(true);
  });

  it('el job periódico corre solo y se detiene', async () => {
    ctx.invariant.last = undefined;
    ctx.invariant.start(50);
    const report = await waitFor(async () => ctx.invariant.last, 5000, 50);
    await ctx.invariant.stop();
    expect(report.ok).toBe(true);
  });
});
