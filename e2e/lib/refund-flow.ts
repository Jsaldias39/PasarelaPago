import type { Stack } from '../stack.ts';
import { serviceDb } from './db.ts';
import type { SeededMerchant } from './seed.ts';
import { until } from './wait.ts';

export interface PublicRefund {
  readonly id: string;
  readonly object: 'refund';
  readonly payment_intent: string;
  readonly amount_minor: number;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly failure_code: string | null;
}

/** La API pública de reembolsos de pay-edge con la llave `sk_test_` de un comercio sembrado. */
export function refundApi(stack: Stack, merchant: SeededMerchant) {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${merchant.token}`, ...extra });
  return {
    async create(intentId: string, amountMinor: number, idempotencyKey: string, reason: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'other' = 'requested_by_customer') {
      const res = await stack.call('pay-edge', 'POST', `/v1/payment_intents/${intentId}/refunds`, { headers: headers({ 'idempotency-key': idempotencyKey }), json: { amount_minor: amountMinor, reason }, timeoutMs: 30_000 });
      return { status: res.status, replayed: res.headers.get('idempotency-replayed'), body: res.json as PublicRefund & { code?: string; errors?: { field: string; code: string }[] } };
    },
    async get(id: string): Promise<PublicRefund> {
      const res = await stack.call('pay-edge', 'GET', `/v1/refunds/${id}`, { headers: headers() });
      if (res.status !== 200) throw new Error(`GET /v1/refunds/${id} respondió ${res.status}`);
      return res.json as PublicRefund;
    },
    /** Espera (por condición) a que el reembolso deje de estar `pending`. */
    settle(id: string, timeoutMs = 60_000) {
      return until(`el reembolso ${id} llega a un estado terminal`, () => this.get(id), (refund) => refund.status !== 'pending', timeoutMs, 250);
    },
  };
}

export interface BalanceView {
  /** Disponible: créditos confirmados − débitos confirmados − débitos pendientes (retenciones). */
  readonly available: number;
  readonly pendingDebits: number;
}

export interface HoldView {
  readonly id: string;
  readonly status: 'pending' | 'posted' | 'voided' | 'expired' | 'rejected';
  readonly business_ref: string;
  readonly debit_account: string;
  readonly credit_account: string;
  readonly amount_minor: number;
  readonly posted_amount_minor: number | null;
}

export interface Line {
  readonly id: string;
  readonly direction: 'debit' | 'credit';
  readonly amount_minor: number;
  readonly business_ref: string;
  readonly counterparty_account: string;
}

/** Lo que `pay-ledger` REAL dice (solo lectura, con la identidad de pay-payments): saldos con retenciones, retenciones y extractos. */
export function refundLedger(stack: Stack) {
  const get = (path: string) => stack.callAs('pay-payments', 'pay-ledger', 'GET', path, { payMode: 'test' });
  return {
    async balance(account: string): Promise<BalanceView> {
      const res = await get(`/balances?account=${encodeURIComponent(account)}`);
      if (res.status === 404) return { available: 0, pendingDebits: 0 };
      if (res.status !== 200) throw new Error(`GET /balances?account=${account} respondió ${res.status}`);
      const body = res.json as { balance_minor: number; pending_debits_minor: number };
      return { available: body.balance_minor, pendingDebits: body.pending_debits_minor };
    },
    async hold(id: string): Promise<HoldView> {
      const res = await get(`/holds/${id}`);
      if (res.status !== 200) throw new Error(`GET /holds/${id} respondió ${res.status}: ${res.text}`);
      return res.json as HoldView;
    },
    /** Todas las líneas CONFIRMADAS del extracto de la cuenta (una cuenta que nadie nombró todavía no existe: extracto vacío). */
    async lines(account: string): Promise<Line[]> {
      const res = await get(`/statements?account=${encodeURIComponent(account)}&limit=100`);
      if (res.status === 404) return [];
      if (res.status !== 200) throw new Error(`GET /statements?account=${account} respondió ${res.status}`);
      return (res.json as { data: Line[] }).data;
    },
    async linesOfRef(account: string, businessRef: string): Promise<Line[]> {
      return (await this.lines(account)).filter((l) => l.business_ref === businessRef);
    },
  };
}

/** Lo que cada servicio guardó de UN reembolso (filas reales; solo lectura). */
export async function refundRows(stack: Stack, refundId: string) {
  const payment = await serviceDb(stack, 'payments', async (db) => {
    const rows = (await db.query('SELECT id, status, failure_code, ledger_hold_id, ledger_transfer_id, connector_refund_id, amount_minor::text AS amount_minor FROM refunds WHERE id = $1', [refundId])).rows as {
      id: string; status: string; failure_code: string | null; ledger_hold_id: string | null; ledger_transfer_id: string | null; connector_refund_id: string | null; amount_minor: string;
    }[];
    const escalations = (await db.query("SELECT kind, reason, source_event_id FROM intent_contradictions WHERE source_event_id LIKE $1", [`ambiguous:%:${refundId}`])).rows as { kind: string; reason: string; source_event_id: string }[];
    return { rows, escalations };
  });
  const connector = await serviceDb(stack, 'connectors', async (db) =>
    (await db.query('SELECT id, status, failure_code, idempotency_key, amount_minor::text AS amount_minor, may_have_reached_provider, send_claims FROM connector_refunds WHERE refund_id = $1', [refundId])).rows as {
      id: string; status: string; failure_code: string | null; idempotency_key: string; amount_minor: string; may_have_reached_provider: boolean; send_claims: number;
    }[]);
  const bank = await serviceDb(stack, 'mockbank', async (db) => {
    const ids = connector.map((c) => c.id);
    if (ids.length === 0) return [] as { reference: string; amount_minor: string }[];
    return (await db.query('SELECT reference, amount_minor::text AS amount_minor FROM mb_refunds WHERE reference = ANY($1::text[])', [ids])).rows as { reference: string; amount_minor: string }[];
  });
  return { payment: payment.rows, escalations: payment.escalations, connector, bank };
}
