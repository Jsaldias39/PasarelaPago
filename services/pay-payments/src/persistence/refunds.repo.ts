import { ProblemError } from '@pay/problem';
import { num, type Db } from './db';

export interface RefundRow {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly reason: string | null;
  readonly failureCode: string | null;
  readonly ledgerHoldId: string | null;
  readonly ledgerTransferId: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const COLUMNS = 'id, payment_intent_id, merchant_id, amount_minor, currency, status, reason, failure_code, ledger_hold_id, ledger_transfer_id, metadata, created_at, completed_at';

function map(r: Record<string, unknown>): RefundRow {
  return {
    id: r.id as string,
    paymentIntentId: r.payment_intent_id as string,
    merchantId: r.merchant_id as string,
    amountMinor: num(r.amount_minor),
    currency: r.currency as string,
    status: r.status as RefundRow['status'],
    reason: (r.reason as string | null) ?? null,
    failureCode: (r.failure_code as string | null) ?? null,
    ledgerHoldId: (r.ledger_hold_id as string | null) ?? null,
    ledgerTransferId: (r.ledger_transfer_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, string>) ?? {},
    createdAt: new Date(r.created_at as string),
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
  };
}

export const refundsRepo = {
  async insert(db: Db, r: { id: string; paymentIntentId: string; merchantId: string; amountMinor: number; reason?: string | undefined; metadata: Record<string, string> }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO refunds (id, payment_intent_id, merchant_id, amount_minor, reason, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.paymentIntentId, r.merchantId, r.amountMinor, r.reason ?? null, JSON.stringify(r.metadata)],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async byId(db: Db, id: string): Promise<RefundRow | null> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM refunds WHERE id = $1`, [id]);
    return rows[0] ? map(rows[0]) : null;
  },
  async forMerchant(db: Db, merchantId: string, id: string): Promise<RefundRow> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM refunds WHERE id = $1 AND merchant_id = $2`, [id, merchantId]);
    if (!rows[0]) throw new ProblemError('resource_not_found');
    return map(rows[0]);
  },
  /** Suma de reembolsos que cuentan contra el cobro: los pendientes y los exitosos (los fallidos devolvieron su cupo). */
  async committedAmount(db: Db, paymentIntentId: string): Promise<number> {
    const { rows } = await db.query("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refunds WHERE payment_intent_id = $1 AND status IN ('pending', 'succeeded')", [paymentIntentId]);
    return num(rows[0]?.total ?? 0);
  },
  async setHold(db: Db, id: string, holdId: string): Promise<void> {
    await db.query('UPDATE refunds SET ledger_hold_id = $2 WHERE id = $1', [id, holdId]);
  },
  /** Cierra el reembolso (una sola vez): solo pasa de `pending`. */
  async complete(db: Db, id: string, status: 'succeeded' | 'failed', patch: { failureCode?: string; ledgerTransferId?: string }): Promise<RefundRow | null> {
    const { rows } = await db.query(
      `UPDATE refunds SET status = $2, failure_code = $3, ledger_transfer_id = $4, completed_at = now() WHERE id = $1 AND status = 'pending' RETURNING ${COLUMNS}`,
      [id, status, patch.failureCode ?? null, patch.ledgerTransferId ?? null],
    );
    return rows[0] ? map(rows[0]) : null;
  },
};
