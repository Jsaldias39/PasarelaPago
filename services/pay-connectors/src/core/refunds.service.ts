import { Inject, Injectable } from '@nestjs/common';
import { hashRequest, IdempotencyStore, type HandlerResult, type IdempotencyContext, type IdempotencyResult } from '@pay/idempotency';
import { enqueue } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError } from '../domain/connector';
import { newId } from '../ids';
import { parseCreateRefund } from './charge.dto';
import { statusChangedEvent } from './events';
import { ChargesService } from './charges.service';
import { ProviderGateway } from './provider-gateway';
import { withSendLock } from './send-lock';
import { refundView, toChargeRow, toRefundRow, type RefundRow } from './rows';
import { CLOCK, LOCK_POOL, type Clock } from './tokens';

@Injectable()
export class RefundsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOCK_POOL) private readonly lockPool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly idempotency: IdempotencyStore,
    private readonly charges: ChargesService,
    private readonly gateway: ProviderGateway,
  ) {}

  /**
   * Fases: `started → refund_recorded` (se valida y se RESERVA el importe en una transacción, con el cobro bloqueado: dos reembolsos
   * simultáneos no pueden sumar más que lo cobrado) y `refund_recorded → refund_sent` (se llama al proveedor con `cr_…` como referencia).
   */
  async create(caller: string, key: string, chargeId: string, body: unknown): Promise<IdempotencyResult> {
    const input = parseCreateRefund(body);
    await this.charges.byId(chargeId); // 404 antes de tocar la idempotencia
    return this.idempotency.execute({ scope: caller, key, requestHash: hashRequest({ method: 'POST', path: `/charges/${chargeId}/refunds`, body }) }, async (ctx): Promise<HandlerResult> => {
      let refund: RefundRow;
      if (ctx.recoveryPoint === 'started') {
        refund = await ctx.atomic('refund_recorded', async (client) => {
          const locked = await client.query('SELECT * FROM connector_charges WHERE id = $1 FOR UPDATE', [chargeId]);
          const charge = toChargeRow(locked.rows[0]);
          if (charge.provider_status !== 'captured') throw new ProblemError('invalid_state_transition', { detail: 'Solo se reembolsa un cobro pagado' });
          const reserved = await client.query(`SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM connector_refunds WHERE charge_id = $1 AND status <> 'failed'`, [chargeId]);
          const alreadyMinor = BigInt(reserved.rows[0].total as string);
          if (alreadyMinor + input.amountMinor > charge.amount_minor) {
            throw new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'exceeds_refundable' }] });
          }
          const inserted = await client.query(
            `INSERT INTO connector_refunds (id, charge_id, caller, idempotency_key, amount_minor, currency, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'BOB', $6, $6) RETURNING *`,
            [newId('cr'), chargeId, caller, key, input.amountMinor.toString(), this.clock.now()],
          );
          return toRefundRow(inserted.rows[0]);
        });
      } else {
        const found = await this.pool.query('SELECT * FROM connector_refunds WHERE caller = $1 AND idempotency_key = $2', [caller, key]);
        if (found.rows.length === 0) throw new Error('Punto de recuperación sin reembolso: la tabla y la Idempotency-Key se desincronizaron');
        refund = toRefundRow(found.rows[0]);
      }
      if (ctx.recoveryPoint === 'refund_recorded') refund = await this.send(ctx, refund);
      return { status: 201, body: refundView(refund) };
    });
  }

  /** Envío al proveedor SERIALIZADO por reembolso: un segundo envío concurrente espera y reutiliza lo que dejó el primero. */
  private async send(ctx: IdempotencyContext, initial: RefundRow): Promise<RefundRow> {
    return withSendLock(this.lockPool, initial.id, async () => {
      let refund = toRefundRow((await this.pool.query('SELECT * FROM connector_refunds WHERE id = $1', [initial.id])).rows[0]);
      if (refund.status === 'succeeded' || (refund.status === 'failed' && refund.failure_code !== 'connector_unavailable')) return refund; // ya lo resolvió otro envío
      const charge = await this.charges.byId(refund.charge_id);
      if (!charge.provider_reference) throw new ProblemError('invalid_state_transition');
      if (refund.status === 'failed') {
        // Reintento de un reembolso que quedó sin efecto por un proveedor caído: se vuelve a reservar el importe, revalidando.
        // El flag `may_have_reached_provider` NO se baja (es monótono): el próximo fallo de disponibilidad se tratará como ambiguo.
        const failed = refund;
        refund = await ctx.atomic('refund_recorded', async (client) => {
          await client.query('SELECT 1 FROM connector_charges WHERE id = $1 FOR UPDATE', [charge.id]);
          const others = await client.query(`SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM connector_refunds WHERE charge_id = $1 AND status <> 'failed' AND id <> $2`, [charge.id, failed.id]);
          if (BigInt(others.rows[0].total as string) + failed.amount_minor > charge.amount_minor) {
            throw new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'exceeds_refundable' }] });
          }
          const reopened = await client.query(`UPDATE connector_refunds SET status = 'pending', failure_code = NULL, updated_at = $2 WHERE id = $1 RETURNING *`, [failed.id, this.clock.now()]);
          return toRefundRow(reopened.rows[0]);
        });
      }
      // Leer el flag y marcarlo en UN solo paso atómico (ver transfers.service).
      const claim = await this.pool.query(
        `WITH old AS (SELECT may_have_reached_provider AS prior FROM connector_refunds WHERE id = $1 FOR UPDATE)
         UPDATE connector_refunds r SET may_have_reached_provider = true, send_claims = r.send_claims + 1, updated_at = $2
           FROM old WHERE r.id = $1 RETURNING old.prior AS prior, r.send_claims AS mine`,
        [refund.id, this.clock.now()],
      );
      const { prior, mine } = claim.rows[0] as { prior: boolean; mine: number };
      const current = refund;
      try {
        const result = await this.gateway.callIdempotent(charge.connector, current.id, 'refund', (c) =>
          c.refund({ reference: current.id, chargeReference: charge.id, amountMinor: current.amount_minor }, this.clock.now()),
        );
        const status = result.status === 'captured' ? 'succeeded' : result.status;
        return await ctx.atomic('refund_sent', (client) => this.settle(client, current, charge, status, result.providerReference, result.failureCode ?? null));
      } catch (error) {
        if (error instanceof ConnectorUnavailableError && !prior) {
          // «Sin efecto» solo si este envío fue el único que reclamó (send_claims = mine) y ningún intento previo pudo llegar, en la misma
          // sentencia que el cambio de estado. Se libera la reserva (sin evento); el flag no se toca.
          const released = await this.pool.query(
            `UPDATE connector_refunds SET status = 'failed', failure_code = 'connector_unavailable', updated_at = $3
              WHERE id = $1 AND status = 'pending' AND provider_reference IS NULL AND send_claims = $2`,
            [current.id, mine, this.clock.now()],
          );
          if (released.rowCount === 1) throw new ProblemError('connector_unavailable', { detail: 'El proveedor no está disponible para reembolsar' });
          throw new ProblemError('internal_error', { detail: 'Resultado ambiguo; reintentá con la misma Idempotency-Key o consultá el cobro' });
        }
        if (error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError || (error instanceof ConnectorRejectedError && prior)) {
          // AMBIGUO (regla 11): el reembolso pudo ejecutarse. La reserva se mantiene, NO se dice «sin efecto» y el reintento usa `cr_…`.
          throw new ProblemError('internal_error', { detail: 'Resultado ambiguo; reintentá con la misma Idempotency-Key o consultá el cobro' });
        }
        if (error instanceof ConnectorRejectedError) {
          await ctx.atomic('refund_sent', (client) => this.settle(client, current, charge, 'failed', null, error.code));
          throw new ProblemError(error.code === 'invalid_state_transition' ? 'invalid_state_transition' : 'validation_failed', { detail: 'El proveedor rechazó el reembolso' });
        }
        throw error;
      }
    });
  }

  private async settle(
    client: Parameters<typeof enqueue>[0],
    refund: RefundRow,
    charge: { id: string; connector: Parameters<typeof statusChangedEvent>[0]['connector']; payment_intent_id: string; merchant_id: string },
    status: 'pending' | 'succeeded' | 'failed',
    providerReference: string | null,
    failureCode: string | null,
  ): Promise<RefundRow> {
    const now = this.clock.now();
    const updated = await client.query(
      `UPDATE connector_refunds SET status = $2, provider_reference = $3, failure_code = $4, updated_at = $5 WHERE id = $1 AND status = 'pending' RETURNING *`,
      [refund.id, status, providerReference, failureCode, now],
    );
    // Ya resuelto por otro camino: no se vuelve a escribir ni a publicar.
    if (!updated.rows[0]) return toRefundRow((await client.query('SELECT * FROM connector_refunds WHERE id = $1', [refund.id])).rows[0]);
    const row = toRefundRow(updated.rows[0]);
    // El reembolso es síncrono en el contrato (201 con el estado): el evento lo informa a pay-payments/pay-settlement con `status_inquiry`.
    if (status !== 'pending') {
      await enqueue(
        client,
        statusChangedEvent({
          connector: charge.connector,
          kind: 'refund',
          internalId: refund.id,
          paymentIntentId: charge.payment_intent_id,
          merchantId: charge.merchant_id,
          status: status === 'succeeded' ? 'captured' : 'failed',
          amountMinor: refund.amount_minor,
          providerEventId: `refund:${refund.id}:${status}`,
          occurredAt: now,
          observedVia: 'status_inquiry',
          failureCode,
        }),
        { aggregateType: 'connector_refund', aggregateId: refund.id },
      );
    }
    return row;
  }
}

