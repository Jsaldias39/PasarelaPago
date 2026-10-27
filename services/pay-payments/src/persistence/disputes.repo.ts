import { num, type Db } from './db';

export interface DisputeRow {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly evidence: string[];
  readonly ledgerTransferId: string | null;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
}

const COLUMNS = 'id, payment_intent_id, merchant_id, amount_minor, currency, status, evidence, ledger_transfer_id, opened_at, resolved_at';

function map(r: Record<string, unknown>): DisputeRow {
  return {
    id: r.id as string,
    paymentIntentId: r.payment_intent_id as string,
    merchantId: r.merchant_id as string,
    amountMinor: num(r.amount_minor),
    currency: r.currency as string,
    status: r.status as DisputeRow['status'],
    evidence: (r.evidence as string[]) ?? [],
    ledgerTransferId: (r.ledger_transfer_id as string | null) ?? null,
    openedAt: new Date(r.opened_at as string),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : null,
  };
}

export const disputesRepo = {
  /** @returns `false` si ya había una disputa abierta para el cobro (índice único parcial). */
  async insert(db: Db, d: { id: string; paymentIntentId: string; merchantId: string; amountMinor: number }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO disputes (id, payment_intent_id, merchant_id, amount_minor) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [d.id, d.paymentIntentId, d.merchantId, d.amountMinor],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async byId(db: Db, id: string): Promise<DisputeRow | null> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM disputes WHERE id = $1`, [id]);
    return rows[0] ? map(rows[0]) : null;
  },
  /** Agrega una referencia de evidencia (id de documento, nunca su contenido). Solo mientras está abierta. */
  async addEvidence(db: Db, id: string, reference: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE disputes SET evidence = evidence || to_jsonb($2::text) WHERE id = $1 AND status = 'open' AND NOT evidence @> to_jsonb($2::text)`,
      [id, reference],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async resolve(db: Db, id: string, status: 'won' | 'lost', ledgerTransferId?: string): Promise<DisputeRow | null> {
    const { rows } = await db.query(
      `UPDATE disputes SET status = $2, ledger_transfer_id = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING ${COLUMNS}`,
      [id, status, ledgerTransferId ?? null],
    );
    return rows[0] ? map(rows[0]) : null;
  },
};
