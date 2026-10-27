import { createSign } from 'node:crypto';
import { Client } from 'pg';
import { quoteFee, type ChannelRule } from '@pay/money';
import type { Stack } from '../stack.ts';
import { type BusEvent, readStream } from './events.ts';
import { until } from './wait.ts';

/**
 * Ayudantes de los flujos E4 y E8 (carril P2). Solo se agregan acá; no se modifica nada de P1.
 * Todo lo que toca una base o firma algo es una SIEMBRA o un DOBLE declarado, igual que `seed.ts`.
 */

/** La tarifa de la siembra (`seedMerchant`): la misma que usa el ledger de E1 (QR 2,5 % + Bs 0,50; transferencia 1 %). */
export const SEED_CHANNELS: readonly ChannelRule[] = [
  { channel: 'qr', percent: '2.5', fixed_minor: 50 },
  { channel: 'bank_transfer', percent: '1', fixed_minor: 0 },
];

/** Comisión y neto de un cobro con la tarifa de la siembra, calculados con la MISMA función que los servicios (`@pay/money`). */
export function quote(channel: 'qr' | 'bank_transfer', grossMinor: number): { fee: number; net: number } {
  const q = quoteFee(SEED_CHANNELS, channel, BigInt(grossMinor));
  return { fee: Number(q.feeMinor), net: Number(q.netMinor) };
}

/** Identidad de servicio con la que la consola de operación llama a settlement (D-31). */
export const BACKOFFICE = 'pay-backoffice';

/**
 * Credencial de la persona operadora (JWT RS256) firmada con la clave PRIVADA sintética de la corrida; settlement verifica con la pública
 * (`OPERATOR_TOKEN_PUBLIC_KEY`) y el emisor y la audiencia que arma `envFor`. Es un DOBLE del servicio de identidad, que todavía no existe.
 */
export function operatorBearer(stack: Stack, roles: readonly string[], options: { sub?: string; expiresInSeconds?: number } = {}): string {
  const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const payload = b64({ iss: 'e2e-issuer', aud: 'pay-settlement', sub: options.sub ?? 'op_e2e_maria', roles, iat: now, exp: now + (options.expiresInSeconds ?? 300) });
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(stack.secrets.operatorPrivateKeyPem);
  return `Bearer ${header}.${payload}.${signature.toString('base64url')}`;
}

/** Llamada a pay-settlement como la consola de operación, en modo `test` (el despliegue del arnés es sandbox). */
export function backoffice(stack: Stack, method: string, path: string, options: { json?: unknown; idempotencyKey?: string; operator?: string; payMode?: 'test' | 'live' | null } = {}) {
  return stack.callAs(BACKOFFICE, 'pay-settlement', method, path, {
    ...(options.payMode !== undefined && { payMode: options.payMode }),
    headers: { ...(options.idempotencyKey && { 'idempotency-key': options.idempotencyKey }), ...(options.operator && { authorization: options.operator }) },
    ...(options.json !== undefined && { json: options.json }),
  });
}

/**
 * Espera a que settlement conozca al comercio (lo aprende por el evento `fee_schedule.published` de la siembra, NATS mediante). El directorio no
 * tiene API: se lee con SQL de SOLO LECTURA sobre la base de pay-settlement, con el rol del propio servicio de la corrida.
 */
export async function waitForSettlementToKnow(stack: Stack, merchantId: string, timeoutMs = 30_000): Promise<void> {
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: 'pay_settlement', user: 'pay_settlement', password: 'dev_only_settlement' });
  await client.connect();
  try {
    await until(`pay-settlement conoce a ${merchantId}`, async () => (await client.query('SELECT 1 FROM settlement_merchants WHERE merchant_id = $1', [merchantId])).rowCount, (n) => n === 1, timeoutMs, 200);
  } finally {
    await client.end();
  }
}

/**
 * Lunes de corte más reciente cuya medianoche local (UTC−4, D-19) ya pasó. `POST /batches` rechaza una fecha futura y, con el reloj REAL del ledger, lo
 * que se cobra durante la prueba es SIEMPRE posterior a esa medianoche: por eso el corte de E4 no libera cobros frescos (ver FLUJOS-E4-E8.md).
 */
export function lastCutoffMonday(now: Date = new Date(), tzOffsetMinutes = -240): string {
  for (let back = 0; back < 14; back += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    if (day.getUTCDay() !== 1) continue;
    const localMidnight = day.getTime() - tzOffsetMinutes * 60_000;
    if (localMidnight <= now.getTime()) return day.toISOString().slice(0, 10);
  }
  throw new Error('No se encontró un lunes de corte en las últimas dos semanas');
}

/** Lo que el ledger REAL dice de una cuenta, visto por el servicio que la consulta. Una cuenta que nadie nombró todavía vale 0. */
export function ledgerView(stack: Stack, caller: 'pay-payments' | 'pay-settlement' = 'pay-settlement') {
  const get = (path: string) => stack.callAs(caller, 'pay-ledger', 'GET', path, { payMode: 'test' });
  return {
    async balance(account: string): Promise<number> {
      const res = await get(`/balances?account=${encodeURIComponent(account)}`);
      if (res.status === 404) return 0;
      if (res.status !== 200) throw new Error(`GET /balances ${account} respondió ${res.status}`);
      return (res.json as { balance_minor: number }).balance_minor;
    },
    async lines(account: string): Promise<{ direction: 'debit' | 'credit'; amount_minor: number; business_ref: string; code: string }[]> {
      const res = await get(`/statements?account=${encodeURIComponent(account)}&limit=100`);
      if (res.status === 404) return [];
      if (res.status !== 200) throw new Error(`GET /statements ${account} respondió ${res.status}`);
      return (res.json as { data: { direction: 'debit' | 'credit'; amount_minor: number; business_ref: string; code: string }[] }).data;
    },
  };
}

/**
 * [DOBLE de pay-payments] El asiento de captura que `recordLedger` de pay-payments manda al ledger REAL: una pata `charge` por el neto y una `fee` por la
 * comisión, desde la cuenta de compensación del conector. Con `pay-payments` bloqueado (D-29/D-30) el flujo lo manda este doble; la versión sin
 * doble es E1/E2 (`e2e/pending`).
 */
export async function postCapture(stack: Stack, input: { merchantId: string; paymentIntentId: string; grossMinor: number; channel: 'qr' | 'bank_transfer'; connector: 'mock' | 'bank_transfer' }) {
  const { fee, net } = quote(input.channel, input.grossMinor);
  const clearing = `connector:${input.connector}:clearing`;
  const res = await stack.callAs('pay-payments', 'pay-ledger', 'POST', '/transactions', {
    merchantId: input.merchantId,
    payMode: 'test',
    headers: { 'idempotency-key': `${input.paymentIntentId}:capture:1` },
    json: {
      business_ref: `${input.paymentIntentId}:capture`,
      attempt: 1,
      currency: 'BOB',
      legs: [
        { debit_account: clearing, credit_account: `merchant:${input.merchantId}:pending`, amount_minor: net, code: 'charge' },
        { debit_account: clearing, credit_account: 'platform:fees', amount_minor: fee, code: 'fee' },
      ],
    },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`POST /transactions (captura de ${input.paymentIntentId}) respondió ${res.status}: ${res.text}`);
  return { fee, net, status: res.status };
}

/** Partida doble de UN asiento: débitos y créditos del `business_ref` sobre las cuentas indicadas. */
export async function doubleEntryOf(stack: Stack, businessRef: string, accounts: readonly string[]): Promise<{ debits: number; credits: number }> {
  const view = ledgerView(stack);
  const all = (await Promise.all(accounts.map((a) => view.lines(a)))).flat().filter((l) => l.business_ref === businessRef);
  const sum = (direction: 'debit' | 'credit') => all.filter((l) => l.direction === direction).reduce((total, l) => total + l.amount_minor, 0);
  return { debits: sum('debit'), credits: sum('credit') };
}

/** Espera (por condición) a que el relé del outbox haya publicado al menos `min` eventos del tema que cumplan `accept`, y los devuelve. */
export function awaitEvents(stack: Stack, stream: string, subject: string, accept: (event: BusEvent) => boolean, min = 1, timeoutMs = 30_000): Promise<BusEvent[]> {
  return until(`al menos ${min} evento(s) ${subject}`, () => readStream(stack, stream, subject, accept), (events) => events.length >= min, timeoutMs, 300);
}
