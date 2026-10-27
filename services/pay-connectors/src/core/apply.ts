import { enqueue, type Queryable } from '@pay/outbox';
import type { ConnectorCode, ProviderEvent } from '../domain/connector';
import { callbackResultOf, decideCallback } from '../domain/callback-machine';
import { statusChangedEvent, type ObservedVia } from './events';
import { toChargeRow, type ChargeRow } from './rows';

export type CallbackOutcome = 'applied' | 'duplicate' | 'stale' | 'contradiction';

export interface Applied {
  readonly result: CallbackOutcome;
  readonly chargeId: string | null;
}

export async function lockCharge(client: Queryable, id: string): Promise<ChargeRow | null> {
  const found = await client.query('SELECT * FROM connector_charges WHERE id = $1 FOR UPDATE', [id]);
  return found.rows[0] ? toChargeRow(found.rows[0]) : null;
}

/**
 * Único camino por el que un hecho del proveedor (callback, consulta de estado, anulación) toca un cobro.
 * DEBE correr dentro de una transacción abierta: el cobro queda bloqueado (`FOR UPDATE`), el hecho se registra (deduplicado por
 * `(connector, provider_event_id)`), se decide con la máquina de estados y, solo si avanza, se actualiza el cobro y se encola el
 * evento — todo o nada.
 *
 * - El MODO sale del registro del cobro (`pay_mode`), nunca del callback: el banco no manda `X-Pay-Mode` y, si lo mandara, se ignora.
 * - Referencia desconocida o de otro conector ⇒ `contradiction` registrada (sin cobro que tocar).
 * - Importe informado distinto del cobrado ⇒ `contradiction`: el estado no se mueve y queda para conciliación humana.
 */
export async function recordAndApply(client: Queryable, connector: ConnectorCode, event: ProviderEvent, via: ObservedVia, now: Date): Promise<Applied> {
  const locked = await lockCharge(client, event.chargeReference);
  const charge = locked && locked.connector === connector ? locked : null;

  let result: CallbackOutcome;
  if (!charge) {
    result = 'contradiction';
  } else if (event.amountMinor !== undefined && event.amountMinor !== charge.amount_minor) {
    result = 'contradiction';
  } else {
    result = callbackResultOf(decideCallback(charge.provider_status, event.status));
  }

  const inserted = await client.query(
    `INSERT INTO connector_callback_events (connector, provider_event_id, charge_id, pay_mode, status, result, observed_via, occurred_at, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (connector, provider_event_id) DO NOTHING
     RETURNING 1`,
    [connector, event.providerEventId, charge?.id ?? null, charge?.pay_mode ?? null, event.status, result, via, event.occurredAt, now],
  );
  // Misma clave ya registrada: es una reentrega. No se vuelve a decidir ni a publicar nada.
  if (inserted.rows.length === 0) return { result: 'duplicate', chargeId: charge?.id ?? null };

  if (charge && result === 'applied') {
    const failureCode = event.status === 'failed' ? (event.failureCode ?? 'internal_error') : null;
    await client.query(
      `UPDATE connector_charges
          SET provider_status = $2, failure_code = $3, ambiguous = false,
              last_provider_event_at = GREATEST(COALESCE(last_provider_event_at, $4), $4), updated_at = $5
        WHERE id = $1`,
      [charge.id, event.status, failureCode, event.occurredAt, now],
    );
    await enqueue(
      client,
      statusChangedEvent({
        connector,
        kind: 'charge',
        internalId: charge.id,
        paymentIntentId: charge.payment_intent_id,
        merchantId: charge.merchant_id,
        status: event.status,
        amountMinor: charge.amount_minor,
        providerEventId: event.providerEventId,
        occurredAt: event.occurredAt,
        observedVia: via,
        failureCode,
      }),
      { aggregateType: 'connector_charge', aggregateId: charge.id },
    );
  }
  return { result, chargeId: charge?.id ?? null };
}
