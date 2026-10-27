import type { ConnectorCode, Method, Mode, NextAction, ProviderStatus } from '../domain/connector';
import { chargeStatusOf, type ChargeStatus } from '../domain/status-map';

export interface ChargeRow {
  id: string;
  caller: string;
  idempotency_key: string;
  payment_intent_id: string;
  merchant_id: string;
  connector: ConnectorCode;
  mode: Mode;
  method: Method;
  amount_minor: bigint;
  currency: 'BOB';
  provider_status: ProviderStatus;
  next_action: NextAction | null;
  provider_reference: string | null;
  failure_code: string | null;
  ambiguous: boolean;
  send_claims: number;
  routing_version: number;
  routing_rule: string | null;
  expires_at: Date;
  last_provider_event_at: Date | null;
  poll_attempts: number;
  next_poll_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** `pg` devuelve `bigint` como cadena: se convierte en el borde. */
export function toChargeRow(raw: Record<string, unknown>): ChargeRow {
  return { ...(raw as unknown as ChargeRow), amount_minor: BigInt(raw.amount_minor as string | number | bigint) };
}

export const TERMINAL: ReadonlySet<ProviderStatus> = new Set(['captured', 'failed', 'canceled', 'expired']);

export function publicStatus(row: Pick<ChargeRow, 'provider_status' | 'next_action'>): ChargeStatus {
  return chargeStatusOf(row.provider_status, row.next_action !== null);
}

/** Vista de `Charge` del contrato (`internal-connectors-v1.yaml`). */
export function chargeView(row: ChargeRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'charge',
    payment_intent_id: row.payment_intent_id,
    connector: row.connector,
    mode: row.mode,
    method: row.method,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: publicStatus(row),
    // Una vez resuelto el cobro (cobrado, fallido, vencido, anulado) ya no hay nada que mostrarle al pagador.
    ...(row.next_action && !TERMINAL.has(row.provider_status) ? { next_action: row.next_action } : {}),
    provider_reference: row.provider_reference,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

export interface RefundRow {
  id: string;
  charge_id: string;
  caller: string;
  idempotency_key: string;
  amount_minor: bigint;
  currency: 'BOB';
  status: 'pending' | 'succeeded' | 'failed';
  provider_reference: string | null;
  failure_code: string | null;
  may_have_reached_provider: boolean;
  send_claims: number;
  created_at: Date;
  updated_at: Date;
}

export function toRefundRow(raw: Record<string, unknown>): RefundRow {
  return { ...(raw as unknown as RefundRow), amount_minor: BigInt(raw.amount_minor as string | number | bigint) };
}

export function refundView(row: RefundRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'connector_refund',
    charge_id: row.charge_id,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
  };
}
