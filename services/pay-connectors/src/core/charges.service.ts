import { Inject, Injectable } from '@nestjs/common';
import { hashRequest, IdempotencyStore, type HandlerResult, type IdempotencyContext, type IdempotencyResult } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError, type ConnectorCode } from '../domain/connector';
import { newId } from '../ids';
import { lockCharge, recordAndApply } from './apply';
import { parseCreateCharge, type CreateCharge } from './charge.dto';
import { inTransaction, uniqueViolation } from './db';
import type { PayMode } from './pay-mode';
import { ProviderGateway } from './provider-gateway';
import { withSendLock } from './send-lock';
import { chargeView, publicStatus, TERMINAL, toChargeRow, type ChargeRow } from './rows';
import { RoutingService } from './routing.service';
import { CLOCK, LOCK_POOL, type Clock } from './tokens';

const ID = /^ch_[a-z0-9]{10,40}$/;

@Injectable()
export class ChargesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOCK_POOL) private readonly lockPool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly idempotency: IdempotencyStore,
    private readonly routing: RoutingService,
    private readonly gateway: ProviderGateway,
  ) {}

  /** Lee un cobro por (id, modo): un id del OTRO modo da 404, igual que uno inexistente (no revela que existe). */
  async byId(id: string, mode: PayMode): Promise<ChargeRow> {
    if (!ID.test(id)) throw new ProblemError('resource_not_found');
    const found = await this.pool.query('SELECT * FROM connector_charges WHERE id = $1 AND pay_mode = $2', [id, mode]);
    if (found.rows.length === 0) throw new ProblemError('resource_not_found');
    return toChargeRow(found.rows[0]);
  }

  private async byKey(caller: string, mode: PayMode, key: string): Promise<ChargeRow> {
    const found = await this.pool.query('SELECT * FROM connector_charges WHERE caller = $1 AND pay_mode = $2 AND idempotency_key = $3', [caller, mode, key]);
    if (found.rows.length === 0) throw new Error('Punto de recuperación sin cobro: la tabla y la Idempotency-Key se desincronizaron');
    return toChargeRow(found.rows[0]);
  }

  // ───────────────────────── POST /charges ─────────────────────────

  /**
   * Fases (con puntos de recuperación de `@pay/idempotency`):
   *  1. `started → charge_recorded`: el cobro queda registrado (con el ruteo elegido) en una transacción.
   *  2. `charge_recorded → charge_sent`: se llama al proveedor FUERA de toda transacción de base y el resultado se guarda.
   * Si el proceso muere entre una y otra, el reintento con la misma clave retoma en la fase 2 con la MISMA referencia (`ch_…`).
   */
  async create(caller: string, mode: PayMode, key: string, body: unknown): Promise<IdempotencyResult> {
    const input = parseCreateCharge(body, this.clock.now());
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key, requestHash: hashRequest({ method: 'POST', path: '/charges', body }) }, async (ctx): Promise<HandlerResult> => {
      let row: ChargeRow;
      if (ctx.recoveryPoint === 'started') {
        row = await ctx.atomic('charge_recorded', async (client) => {
          const choice = await this.routing.choose({ method: input.method, amountMinor: input.amountMinor, payMode: mode, ...(input.preferred && { preferred: input.preferred }) });
          const first = choice.candidates[0];
          if (!first) throw new ProblemError('connector_unavailable', { detail: 'Ningún conector disponible para este medio de pago' });
          const connector = this.gateway.connector(first);
          const id = newId('ch');
          try {
            const inserted = await client.query(
              `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency,
                                              routing_version, routing_rule, expires_at, next_poll_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'BOB', $11, $12, $13, $14, $14, $14) RETURNING *`,
              [id, caller, key, input.paymentIntentId, input.merchantId, mode, first, connector.mode, input.method, input.amountMinor.toString(), choice.version, choice.ruleId, input.expiresAt, this.nextPoll(this.clock.now(), 0)],
            );
            return toChargeRow(inserted.rows[0]);
          } catch (error) {
            if (uniqueViolation(error)?.constraint === 'connector_charges_live_intent_uidx') {
              throw new ProblemError('invalid_state_transition', { detail: 'Ya hay un cobro vigente o cobrado para este intento de pago' });
            }
            throw error;
          }
        });
      } else {
        row = await this.byKey(caller, mode, key);
      }
      if (ctx.recoveryPoint === 'charge_recorded') row = await this.send(ctx, row, input);
      return { status: 201, body: chargeView(row) };
    });
  }

  private nextPoll(from: Date, attempts: number): Date {
    const { minAgeMs, baseBackoffMs, maxBackoffMs } = this.config.poller;
    return new Date(from.getTime() + (attempts === 0 ? minAgeMs : Math.min(baseBackoffMs * 2 ** attempts, maxBackoffMs)));
  }

  /**
   * Envío al proveedor SERIALIZADO por cobro: un segundo envío concurrente espera, vuelve a leer lo que dejó el primero y, si el cobro
   * ya llegó al proveedor o terminó, lo devuelve sin llamar de nuevo.
   */
  private async send(ctx: IdempotencyContext, initial: ChargeRow, input: CreateCharge): Promise<ChargeRow> {
    return withSendLock(this.lockPool, initial.id, async () => {
      const row = await this.byId(initial.id, initial.pay_mode);
      if (row.provider_reference !== null || row.provider_status !== 'pending') return row;
      return this.sendLocked(ctx, row, input);
    });
  }

  private async sendLocked(ctx: IdempotencyContext, row: ChargeRow, input: CreateCharge): Promise<ChargeRow> {
    // Un intento anterior pudo haber llegado al proveedor sin que supiéramos el resultado: solo se reintenta ese conector.
    const candidates: ConnectorCode[] = row.ambiguous
      ? [row.connector]
      : [...(await this.routing.choose({ method: input.method, amountMinor: input.amountMinor, payMode: row.pay_mode, ...(input.preferred && { preferred: input.preferred }) })).candidates];
    if (candidates.length === 0) throw new ProblemError('connector_unavailable', { detail: 'Ningún conector disponible para este medio de pago' });
    // Si ya hubo una llamada en vuelo, lo que pase ahora NO prueba que el proveedor no tenga el cobro (regla 11 del CLAUDE.md).
    const priorAmbiguous = row.ambiguous;

    for (const code of candidates) {
      // Marca «llamada en vuelo» ANTES de llamar: si el proceso muere ahora, el reintento no cambia de conector.
      const claimed = await this.pool.query('UPDATE connector_charges SET connector = $2, connector_mode = $3, ambiguous = true, send_claims = send_claims + 1, updated_at = $4 WHERE id = $1 RETURNING send_claims AS mine', [row.id, code, this.gateway.connector(code).mode, this.clock.now()]);
      const mine = (claimed.rows[0] as { mine: number }).mine;
      try {
        const result = await this.gateway.callIdempotent(code, row.id, 'create_charge', (connector) =>
          connector.createCharge(
            {
              reference: row.id,
              paymentIntentId: row.payment_intent_id,
              merchantId: row.merchant_id,
              payMode: row.pay_mode,
              amountMinor: row.amount_minor,
              currency: 'BOB',
              method: row.method,
              expiresAt: row.expires_at,
              ...(input.cardToken && { cardToken: input.cardToken }),
              ...(input.description && { description: input.description }),
            },
            this.clock.now(),
          ),
        );
        return await ctx.atomic('charge_sent', async (client) => {
          const updated = await client.query(
            `UPDATE connector_charges
                SET connector = $2, connector_mode = $3, ambiguous = false,
                    -- La respuesta síncrona solo fija el estado si el cobro sigue pending: un callback o una consulta pudo llegar mientras
                    -- esperábamos al proveedor y su estado (más nuevo) no se pisa. La precondición va en la escritura (regla 96.3).
                    provider_status = CASE WHEN provider_status = 'pending' THEN $4 ELSE provider_status END,
                    failure_code = CASE WHEN provider_status = 'pending' THEN $7 ELSE failure_code END,
                    provider_reference = $5, next_action = $6::jsonb, updated_at = $8
              WHERE id = $1 RETURNING *`,
            [row.id, code, this.gateway.connector(code).mode, result.status, result.providerReference, result.nextAction ? JSON.stringify(result.nextAction) : null, result.failureCode ?? null, this.clock.now()],
          );
          return toChargeRow(updated.rows[0]);
        });
      } catch (error) {
        if (error instanceof ConnectorUnavailableError && priorAmbiguous) {
          // Un intento anterior pudo llegar: no se baja la marca ni se cambia de conector (podría cobrarse dos veces).
          throw new ProblemError('connector_unavailable', { detail: 'El proveedor no respondió; reintentá con la misma Idempotency-Key' });
        }
        if (error instanceof ConnectorUnavailableError) {
          // Seguro: el proveedor no recibió nada. Se baja la marca SOLO si nadie reclamó el cobro después de este envío
          // (`send_claims = mine`, en la misma sentencia) y se prueba con el siguiente conector.
          const cleared = await this.pool.query('UPDATE connector_charges SET ambiguous = false, updated_at = $3 WHERE id = $1 AND send_claims = $2', [row.id, mine, this.clock.now()]);
          if (cleared.rowCount !== 1) throw new ProblemError('connector_unavailable', { detail: 'El proveedor no respondió; reintentá con la misma Idempotency-Key' });
          continue;
        }
        if (error instanceof ConnectorTimeoutError) {
          // Ambiguo: el cobro puede existir. Se queda marcado y NO se prueba con otro conector.
          throw new ProblemError('connector_unavailable', { detail: 'El proveedor no respondió a tiempo; reintentá con la misma Idempotency-Key' });
        }
        if (error instanceof ConnectorRejectedError && priorAmbiguous) {
          throw new ProblemError('connector_unavailable', { detail: 'Resultado ambiguo; reintentá con la misma Idempotency-Key' });
        }
        if (error instanceof ConnectorRejectedError) {
          await this.pool.query(`UPDATE connector_charges SET provider_status = 'failed', failure_code = $2, ambiguous = false, updated_at = $3 WHERE id = $1`, [row.id, error.code, this.clock.now()]);
          throw new ProblemError(error.code === 'internal_error' ? 'internal_error' : 'validation_failed', { detail: 'El proveedor rechazó el cobro' });
        }
        throw error;
      }
    }
    throw new ProblemError('connector_unavailable', { detail: 'Ningún conector disponible respondió' });
  }

  // ───────────────────────── GET /charges/{id}/status ─────────────────────────

  async status(id: string, refresh: boolean, mode: PayMode): Promise<Record<string, unknown>> {
    let row = await this.byId(id, mode);
    let stale = false;
    if (refresh && !TERMINAL.has(row.provider_status) && row.provider_reference !== null) {
      try {
        const observed = await this.gateway.call(row.connector, row.id, 'get_status', (c) => c.getStatus(row.id, this.clock.now()));
        if (observed.status !== row.provider_status) {
          await inTransaction(this.pool, (client) =>
            recordAndApply(client, row.connector, { providerEventId: `inquiry:${row.id}:${observed.status}`, chargeReference: row.id, status: observed.status, occurredAt: observed.occurredAt, ...(observed.failureCode && { failureCode: observed.failureCode }) }, 'status_inquiry', this.clock.now()),
          );
          row = await this.byId(id, mode);
        }
      } catch (error) {
        if (!(error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError)) throw error;
        stale = true; // el proveedor no responde: se devuelve lo último que se sabe, marcado
      }
    }
    return {
      charge_id: row.id,
      status: publicStatus(row),
      connector: row.connector,
      mode: row.connector_mode,
      failure_code: row.failure_code,
      stale,
      checked_at: this.clock.now().toISOString(),
    };
  }

  // ───────────────────────── POST /charges/{id}/cancel ─────────────────────────

  async cancel(caller: string, mode: PayMode, key: string, id: string): Promise<IdempotencyResult> {
    if (!ID.test(id)) throw new ProblemError('resource_not_found');
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key, requestHash: hashRequest({ method: 'POST', path: `/charges/${id}/cancel` }) }, async (): Promise<HandlerResult> => {
      const row = await this.byId(id, mode);
      if (row.provider_status === 'canceled') return { status: 200, body: chargeView(row) }; // ya anulado: idempotente
      if (TERMINAL.has(row.provider_status)) throw new ProblemError('invalid_state_transition', { detail: 'El cobro ya terminó' });
      if (row.provider_reference !== null) {
        try {
          await this.gateway.call(row.connector, row.id, 'cancel', (c) => c.cancel(row.id, this.clock.now()));
        } catch (error) {
          if (error instanceof ConnectorRejectedError && error.code === 'invalid_state_transition') {
            throw new ProblemError('invalid_state_transition', { detail: 'El proveedor no admite anular este cobro' });
          }
          if (error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError) throw new ProblemError('connector_unavailable');
          throw error;
        }
      }
      const applied = await inTransaction(this.pool, async (client) => {
        const outcome = await recordAndApply(client, row.connector, { providerEventId: `cancel:${row.id}`, chargeReference: row.id, status: 'canceled', occurredAt: this.clock.now() }, 'status_inquiry', this.clock.now());
        const fresh = await lockCharge(client, row.id);
        return { outcome, fresh: fresh as ChargeRow };
      });
      if (applied.fresh.provider_status !== 'canceled') throw new ProblemError('invalid_state_transition', { detail: 'El cobro cambió de estado mientras se anulaba' });
      return { status: 200, body: chargeView(applied.fresh) };
    });
  }
}
