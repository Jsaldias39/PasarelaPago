import type { Stack } from '../stack.ts';
import type { SeededMerchant } from './seed.ts';
import { until } from './wait.ts';

export interface PublicIntent {
  readonly id: string;
  readonly status: 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
  readonly amount_minor: number;
  readonly fee_minor: number;
  readonly net_minor: number;
  readonly next_action?: { type: string; qr?: { payload: string } };
  readonly last_error?: { code: string; message: string } | null;
  readonly succeeded_at?: string | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);

/** La API pública de pay-edge con la llave `sk_test_` de un comercio sembrado. */
export function publicApi(stack: Stack, merchant: SeededMerchant) {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${merchant.token}`, ...extra });
  return {
    async createQrIntent(amountMinor: number, idempotencyKey: string, payerName?: string) {
      const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: headers({ 'idempotency-key': idempotencyKey }), json: { amount_minor: amountMinor, currency: 'BOB', payment_method: { type: 'qr' }, ...(payerName ? { payer_name: payerName } : {}) } });
      return { status: res.status, intent: res.json as PublicIntent };
    },
    async getIntent(id: string): Promise<PublicIntent> {
      const res = await stack.call('pay-edge', 'GET', `/v1/payment_intents/${id}`, { headers: headers() });
      if (res.status !== 200) throw new Error(`GET /v1/payment_intents/${id} respondió ${res.status}`);
      return res.json as PublicIntent;
    },
    /** Espera (por condición) a que el intento llegue a un estado terminal. */
    settle(id: string, timeoutMs = 60_000) {
      return until(`el intento ${id} llega a un estado terminal`, () => this.getIntent(id), (intent) => TERMINAL.has(intent.status), timeoutMs, 250);
    },
    async balance() {
      const res = await stack.call('pay-edge', 'GET', '/v1/balance', { headers: headers() });
      return { status: res.status, body: res.json as { pending_minor: number; available_minor: number } };
    },
  };
}

/** Lo que el ledger REAL dice de un cobro: saldos de las tres cuentas y partida doble sobre el extracto del asiento de captura. */
export async function ledgerOfCapture(stack: Stack, merchantId: string, intentId: string) {
  const call = (path: string) => stack.callAs('pay-payments', 'pay-ledger', 'GET', path, { payMode: 'test' });
  const balance = async (account: string) => {
    const res = await call(`/balances?account=${encodeURIComponent(account)}`);
    return res.status === 404 ? 0 : (res.json as { balance_minor: number }).balance_minor;
  };
  /** Una cuenta que nadie nombró todavía no existe (el ledger la crea al primer asiento): su extracto está vacío. */
  const lines = async (account: string) => {
    const res = await call(`/statements?account=${encodeURIComponent(account)}&limit=100`);
    if (res.status === 404) return [];
    return (res.json as { data: { direction: 'debit' | 'credit'; amount_minor: number; business_ref: string }[] }).data.filter((l) => l.business_ref === `${intentId}:capture`);
  };
  const accounts = [`merchant:${merchantId}:pending`, 'platform:fees', 'connector:mock:clearing'];
  const all = (await Promise.all(accounts.map(lines))).flat();
  const sum = (direction: 'debit' | 'credit') => all.filter((l) => l.direction === direction).reduce((total, l) => total + l.amount_minor, 0);
  return {
    pending: await balance(`merchant:${merchantId}:pending`),
    fees: await balance('platform:fees'),
    debits: sum('debit'),
    credits: sum('credit'),
    /** Cuántas veces se asentó la captura: líneas de crédito sobre el pending del comercio con este business_ref. */
    captureLinesOnPending: (await lines(accounts[0]!)).length,
  };
}
