import { ProblemError } from '@pay/problem';
import { num, type Db } from './db';
import type { IntentStatus } from '../domain/state';

export interface IntentRow {
  readonly id: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: 'qr' | 'card' | 'bank_transfer' | 'wallet';
  readonly status: IntentStatus;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly description: string | null;
  readonly metadata: Record<string, string>;
  readonly nextAction: Record<string, unknown> | null;
  readonly failureCode: string | null;
  readonly connector: string | null;
  readonly chargeId: string | null;
  readonly chargeStatus: string;
  readonly ledgerAttempt: number;
  readonly ledgerTransferId: string | null;
  readonly cardToken: string | null;
  readonly walletUserRef: string | null;
  readonly source: { kind: 'mandate'; id: string; period: string } | null;
  readonly kind: string | null;
  readonly beneficiaryMerchantId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly succeededAt: Date | null;
  readonly completedAt: Date | null;
}

export interface NewIntent {
  readonly id: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly method: IntentRow['method'];
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly description?: string | undefined;
  readonly metadata: Record<string, string>;
  readonly expiresAt: Date;
  readonly cardToken?: string | undefined;
  readonly walletUserRef?: string | undefined;
  readonly source?: IntentRow['source'];
  readonly kind?: string | undefined;
  readonly beneficiaryMerchantId?: string | undefined;
}

const COLUMNS = `id, merchant_id, amount_minor, currency, method, status, fee_minor, net_minor, description, metadata, next_action,
  failure_code, connector, charge_id, charge_status, ledger_attempt, ledger_transfer_id, card_token, wallet_user_ref, source, kind,
  beneficiary_merchant_id, created_at, expires_at, succeeded_at, completed_at`;

function map(r: Record<string, unknown>): IntentRow {
  return {
    id: r.id as string,
    merchantId: r.merchant_id as string,
    amountMinor: num(r.amount_minor),
    currency: r.currency as string,
    method: r.method as IntentRow['method'],
    status: r.status as IntentStatus,
    feeMinor: num(r.fee_minor),
    netMinor: num(r.net_minor),
    description: (r.description as string | null) ?? null,
    metadata: (r.metadata as Record<string, string>) ?? {},
    nextAction: (r.next_action as Record<string, unknown> | null) ?? null,
    failureCode: (r.failure_code as string | null) ?? null,
    connector: (r.connector as string | null) ?? null,
    chargeId: (r.charge_id as string | null) ?? null,
    chargeStatus: r.charge_status as string,
    ledgerAttempt: num(r.ledger_attempt),
    ledgerTransferId: (r.ledger_transfer_id as string | null) ?? null,
    cardToken: (r.card_token as string | null) ?? null,
    walletUserRef: (r.wallet_user_ref as string | null) ?? null,
    source: (r.source as IntentRow['source']) ?? null,
    kind: (r.kind as string | null) ?? null,
    beneficiaryMerchantId: (r.beneficiary_merchant_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    expiresAt: new Date(r.expires_at as string),
    succeededAt: r.succeeded_at ? new Date(r.succeeded_at as string) : null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
  };
}

/** Acceso a `payment_intents`. Toda consulta por comercio filtra por `merchant_id` (BOLA, P3.H1.M6). */
export const intentsRepo = {
  /** Inserta el intento; si el id ya existe (reintento tras una caída) no hace nada. */
  async insert(db: Db, intent: NewIntent): Promise<{ inserted: boolean }> {
    const result = await db.query(
      `INSERT INTO payment_intents (id, merchant_id, amount_minor, method, status, fee_minor, net_minor, description, metadata, expires_at,
                                    card_token, wallet_user_ref, source, kind, beneficiary_merchant_id)
       VALUES ($1, $2, $3, $4, 'processing', $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14)
       ON CONFLICT (id) DO NOTHING`,
      [
        intent.id, intent.merchantId, intent.amountMinor, intent.method, intent.feeMinor, intent.netMinor, intent.description ?? null,
        JSON.stringify(intent.metadata), intent.expiresAt, intent.cardToken ?? null, intent.walletUserRef ?? null,
        intent.source ? JSON.stringify(intent.source) : null, intent.kind ?? null, intent.beneficiaryMerchantId ?? null,
      ],
    );
    return { inserted: (result.rowCount ?? 0) === 1 };
  },

  async byId(db: Db, id: string, options: { forUpdate?: boolean } = {}): Promise<IntentRow | null> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM payment_intents WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ? map(rows[0]) : null;
  },

  /** Un intento ajeno es indistinguible de uno que no existe: 404, nunca 403 (BOLA). */
  async forMerchant(db: Db, merchantId: string, id: string): Promise<IntentRow> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM payment_intents WHERE id = $1 AND merchant_id = $2`, [id, merchantId]);
    if (!rows[0]) throw new ProblemError('resource_not_found');
    return map(rows[0]);
  },

  async byChargeId(db: Db, chargeId: string): Promise<IntentRow | null> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM payment_intents WHERE charge_id = $1`, [chargeId]);
    return rows[0] ? map(rows[0]) : null;
  },

  async byMandatePeriod(db: Db, mandateId: string, period: string): Promise<IntentRow | null> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM payment_intents WHERE source ->> 'id' = $1 AND source ->> 'period' = $2`, [mandateId, period]);
    return rows[0] ? map(rows[0]) : null;
  },

  /**
   * Página de intentos del comercio, de más nuevo a más viejo, con desempate por id (orden determinista, regla 96.6).
   * El cursor es opaco: `base64url(created_at|id)` del último elemento de la página anterior.
   */
  async list(db: Db, merchantId: string, options: { limit: number; startingAfter?: string; status?: string; createdFrom?: Date; createdTo?: Date }): Promise<{ rows: IntentRow[]; hasMore: boolean }> {
    const params: unknown[] = [merchantId];
    const where = ['merchant_id = $1'];
    if (options.status) { params.push(options.status); where.push(`status = $${params.length}`); }
    if (options.createdFrom) { params.push(options.createdFrom); where.push(`created_at >= $${params.length}`); }
    if (options.createdTo) { params.push(options.createdTo); where.push(`created_at <= $${params.length}`); }
    if (options.startingAfter) {
      const cursor = decodeCursor(options.startingAfter);
      params.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(options.limit + 1);
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM payment_intents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    return { rows: rows.slice(0, options.limit).map(map), hasMore: rows.length > options.limit };
  },

  /**
   * Transición con precondición en la escritura (regla 96.3.2): solo cambia si el estado actual es uno de `from`.
   * @returns La fila nueva, o `null` si ya no estaba en un estado de origen (alguien se adelantó).
   */
  async transition(
    db: Db,
    id: string,
    from: readonly IntentStatus[],
    to: IntentStatus,
    patch: { failureCode?: string; nextAction?: Record<string, unknown> | null; connector?: string; chargeId?: string; chargeStatus?: string; ledgerTransferId?: string } = {},
  ): Promise<IntentRow | null> {
    const terminal = ['succeeded', 'failed', 'canceled', 'expired'].includes(to);
    const { rows } = await db.query(
      `UPDATE payment_intents SET
         status = $3,
         failure_code = COALESCE($4, failure_code),
         next_action = CASE WHEN $5::boolean THEN $6::jsonb ELSE next_action END,
         connector = COALESCE($7, connector),
         charge_id = COALESCE($8, charge_id),
         charge_status = COALESCE($9, charge_status),
         ledger_transfer_id = COALESCE($10, ledger_transfer_id),
         succeeded_at = CASE WHEN $3 = 'succeeded' THEN now() ELSE succeeded_at END,
         completed_at = CASE WHEN $11::boolean THEN now() ELSE completed_at END
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING ${COLUMNS}`,
      [
        id, from, to, patch.failureCode ?? null, patch.nextAction !== undefined, patch.nextAction === undefined ? null : JSON.stringify(patch.nextAction),
        patch.connector ?? null, patch.chargeId ?? null, patch.chargeStatus ?? null, patch.ledgerTransferId ?? null, terminal,
      ],
    );
    return rows[0] ? map(rows[0]) : null;
  },

  /** Aplica el último estado del cargo que informó el conector (la máquina `decideCallback` ya dijo `aplicar`). */
  async setChargeStatus(db: Db, id: string, expected: string, next: string): Promise<boolean> {
    const result = await db.query('UPDATE payment_intents SET charge_status = $3 WHERE id = $1 AND charge_status = $2', [id, expected, next]);
    return (result.rowCount ?? 0) === 1;
  },

  /** El intento de ledger sube SOLO tras un rechazo (H-TB1). Condicional al valor anterior: dos activities no lo suben dos veces. */
  async bumpLedgerAttempt(db: Db, id: string, from: number): Promise<number> {
    const { rows } = await db.query('UPDATE payment_intents SET ledger_attempt = $3 WHERE id = $1 AND ledger_attempt = $2 RETURNING ledger_attempt', [id, from, from + 1]);
    if (rows[0]) return num(rows[0].ledger_attempt);
    const current = await this.byId(db, id);
    return current?.ledgerAttempt ?? from + 1;
  },
};

export const encodeCursor = (row: Pick<IntentRow, 'createdAt' | 'id'>): string => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) throw new ProblemError('validation_failed', { detail: 'Cursor inválido', errors: [{ field: 'starting_after', code: 'invalid_cursor' }] });
  return { createdAt, id };
}
