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
import { refundView, toChargeRow, toRefundRow, type RefundRow } from './rows';
import { CLOCK, type Clock } from './tokens';

@Injectable()
export class RefundsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
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

  private async send(ctx: IdempotencyContext, refund: RefundRow): Promise<RefundRow> {
    const charge = await this.charges.byId(refund.charge_id);
    if (!charge.provider_reference) throw new ProblemError('invalid_state_transition');
    if (refund.status === 'failed' && refund.failure_code === 'connector_unavailable') {
      // Reintento de un reembolso que quedó sin efecto por un proveedor caído: se vuelve a reservar el importe, revalidando.
      refund = await ctx.atomic('refund_recorded', async (client) => {
        await client.query('SELECT 1 FROM connector_charges WHERE id = $1 FOR UPDATE', [charge.id]);
        const others = await client.query(`SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM connector_refunds WHERE charge_id = $1 AND status <> 'failed' AND id <> $2`, [charge.id, refund.id]);
        if (BigInt(others.rows[0].total as string) + refund.amount_minor > charge.amount_minor) {
          throw new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'exceeds_refundable' }] });
        }
        const reopened = await client.query(`UPDATE connector_refunds SET status = 'pending', failure_code = NULL, updated_at = $2 WHERE id = $1 RETURNING *`, [refund.id, this.clock.now()]);
        return toRefundRow(reopened.rows[0]);
      });
    }
    try {
      const result = await this.gateway.callIdempotent(charge.connector, charge.id, 'refund', (c) =>
        c.refund({ reference: refund.id, chargeReference: charge.id, amountMinor: refund.amount_minor }, this.clock.now()),
      );
      const status = result.status === 'captured' ? 'succeeded' : result.status;
      return await ctx.atomic('refund_sent', (client) => this.settle(client, refund, charge, status, result.providerReference, result.failureCode ?? null));
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        // Seguro: el proveedor no recibió nada. Se libera la reserva (sin evento) y el llamador anula su retención del ledger.
        // El reintento con la misma clave retoma acá y vuelve a reservar.
        await this.pool.query(`UPDATE connector_refunds SET status = 'failed', failure_code = 'connector_unavailable', updated_at = $2 WHERE id = $1`, [refund.id, this.clock.now()]);
        throw new ProblemError('connector_unavailable', { detail: 'El proveedor no está disponible para reembolsar' });
      }
      if (error instanceof ConnectorTimeoutError) {
        // Ambiguo: el reembolso puede existir. La reserva se mantiene y el reintento usa la misma referencia `cr_…`.
        throw new ProblemError('connector_unavailable', { detail: 'El proveedor no respondió a tiempo; reintentá con la misma Idempotency-Key' });
      }
      if (error instanceof ConnectorRejectedError) {
        await ctx.atomic('refund_sent', (client) => this.settle(client, refund, charge, 'failed', null, error.code));
        throw new ProblemError(error.code === 'invalid_state_transition' ? 'invalid_state_transition' : 'validation_failed', { detail: 'El proveedor rechazó el reembolso' });
      }
      throw error;
    }
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
      `UPDATE connector_refunds SET status = $2, provider_reference = $3, failure_code = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
      [refund.id, status, providerReference, failureCode, now],
    );
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

