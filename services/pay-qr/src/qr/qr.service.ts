import { Inject, Injectable } from '@nestjs/common';
import { toSafeNumber } from '@pay/money';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { buildMpmPayload, EmvFormatError, parseMpmPayload, type ParsedMpm } from '../emv';
import { newId, newPaymentReference } from '../ids';
import type { PayMode } from './pay-mode';
import type { QrKind, QrRow, QrStatus, QrView } from './qr.types';

export interface CreateQr {
  readonly kind: QrKind;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantCity: string;
  readonly mcc?: string;
  readonly amountMinor?: bigint;
  readonly paymentIntentId?: string;
  readonly expiresAt?: Date;
}

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class QrService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
  ) {}

  /** Estado visible: un QR dinámico vencido o anulado deja de estar activo. */
  static statusOf(row: QrRow, now: Date): QrStatus {
    if (row.canceled_at) return 'canceled';
    if (row.expires_at && row.expires_at.getTime() <= now.getTime()) return 'expired';
    return 'active';
  }

  toView(row: QrRow, now = new Date()): QrView {
    return {
      id: row.id,
      object: 'qr',
      kind: row.kind,
      merchant_id: row.merchant_id,
      payment_intent_id: row.payment_intent_id,
      reference: row.reference,
      amount_minor: row.amount_minor === null ? null : toSafeNumber(BigInt(row.amount_minor)),
      currency: 'BOB',
      payload: row.payload,
      status: QrService.statusOf(row, now),
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
    };
  }

  /**
   * Emite un QR. El estático es uno por comercio: si ya hay uno vigente, se devuelve ese. El dinámico es uno por intento:
   * un segundo QR para el mismo intento exige anular el anterior (409 `invalid_state_transition`).
   */
  async create(input: CreateQr, mode: PayMode, now = new Date()): Promise<{ qr: QrRow; created: boolean }> {
    if (input.kind === 'dynamic' && input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw new ProblemError('validation_failed', { errors: [{ field: 'expires_at', code: 'in_the_past' }] });
    }
    if (input.kind === 'static') {
      const existing = await this.pool.query("SELECT * FROM qr_codes WHERE pay_mode = $1 AND merchant_id = $2 AND kind = 'static' AND canceled_at IS NULL", [mode, input.merchantId]);
      if (existing.rows[0]) return { qr: existing.rows[0] as unknown as QrRow, created: false };
    }

    const reference = input.kind === 'dynamic' ? newPaymentReference() : 'static';
    let payload: string;
    try {
      payload = buildMpmPayload({
        kind: input.kind,
        accountGuid: this.config.qr.accountGuid,
        merchantAccountRef: input.merchantId,
        merchantName: input.merchantName,
        merchantCity: input.merchantCity,
        mcc: input.mcc,
        amountMinor: input.amountMinor,
        referenceLabel: input.kind === 'dynamic' ? reference : undefined,
      });
    } catch (error) {
      if (error instanceof EmvFormatError) {
        throw new ProblemError('validation_failed', { errors: [{ field: 'qr', code: error.code }] });
      }
      throw error;
    }
    const id = newId('qr');
    try {
      const inserted = await this.pool.query(
        `INSERT INTO qr_codes (id, kind, pay_mode, merchant_id, payment_intent_id, reference, amount_minor, currency, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'BOB', $8, $9) RETURNING *`,
        [id, input.kind, mode, input.merchantId, input.paymentIntentId ?? null, input.kind === 'dynamic' ? reference : id.replace('_', ''), input.amountMinor?.toString() ?? null, payload, input.expiresAt ?? null],
      );
      return { qr: inserted.rows[0] as unknown as QrRow, created: true };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Carrera entre dos pedidos del mismo comercio estático, o un segundo QR vigente para el mismo intento.
        if (input.kind === 'static') {
          const raced = await this.pool.query("SELECT * FROM qr_codes WHERE pay_mode = $1 AND merchant_id = $2 AND kind = 'static' AND canceled_at IS NULL", [mode, input.merchantId]);
          if (raced.rows[0]) return { qr: raced.rows[0] as unknown as QrRow, created: false };
        }
        throw new ProblemError('invalid_state_transition', { detail: 'El intento ya tiene un QR vigente: anulalo antes de emitir otro' });
      }
      throw error;
    }
  }

  /** Lee por (id, modo): un id del OTRO modo da 404, igual que uno inexistente. */
  async get(id: string, mode: PayMode): Promise<QrRow> {
    const found = await this.pool.query('SELECT * FROM qr_codes WHERE id = $1 AND pay_mode = $2', [id, mode]);
    if (!found.rows[0]) throw new ProblemError('resource_not_found');
    return found.rows[0] as unknown as QrRow;
  }

  async getByReference(reference: string, mode: PayMode): Promise<QrRow> {
    const found = await this.pool.query('SELECT * FROM qr_codes WHERE reference = $1 AND pay_mode = $2', [reference, mode]);
    if (!found.rows[0]) throw new ProblemError('resource_not_found');
    return found.rows[0] as unknown as QrRow;
  }

  /** Anula. Es idempotente: anular lo ya anulado devuelve el mismo QR. Un QR vencido también se puede anular. */
  async cancel(id: string, mode: PayMode, now = new Date()): Promise<QrRow> {
    const updated = await this.pool.query('UPDATE qr_codes SET canceled_at = COALESCE(canceled_at, $3) WHERE id = $1 AND pay_mode = $2 RETURNING *', [id, mode, now]);
    if (!updated.rows[0]) throw new ProblemError('resource_not_found');
    return updated.rows[0] as unknown as QrRow;
  }

  /** Lee un payload cualquiera (utilidad para verificar QR de terceros). No toca la base. */
  decode(payload: string): ParsedMpm {
    try {
      return parseMpmPayload(payload);
    } catch (error) {
      if (error instanceof EmvFormatError) throw new ProblemError('validation_failed', { errors: [{ field: 'payload', code: error.code }] });
      throw error;
    }
  }
}
