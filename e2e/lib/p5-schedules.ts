import { join } from 'node:path';
import { Client } from 'pg';
import type { Stack } from '../stack.ts';
import { ROOT } from './infra.ts';
import { freePorts, isOurProcess, spawnNode, terminate, waitFor, type Managed } from './process.ts';
import { envFor, SERVICES, type EnvContext } from './services.ts';

/**
 * Ayudantes de P5 para el flujo E5 (pagos programados). Todo esto es DOBLE o apoyo de prueba, y cada pieza lo dice:
 *  - `fundWallet`: asiento de APERTURA SINTÉTICO que carga saldo en `merchant:X:available` (no existe todavía una entrada de dinero real a
 *    la billetera: ver docs/trabajo/ola-2/P5/FLUJO-E5.md). Sale de `connector:mock:clearing` (cuenta deudora y sin tope, la misma que usa el
 *    cobro del simulador), con código `adjustment` y un `business_ref` que empieza por `e5-opening`.
 *  - `startExtraExecutors`: procesos REALES de `pay-schedules` adicionales, contra la MISMA base y el MISMO ledger que el del stack. Sirven para
 *    probar que el periodo se ejecuta una sola vez con varios ejecutores en carrera.
 *  - `scheduleDb`: lectura (y el ajuste declarado del reloj) sobre la base de `pay-schedules`.
 */

/** Fecha de La Paz (UTC-4 todo el año) de un instante: la misma regla que usa `pay-schedules`. */
export const laPazToday = (now: Date = new Date()): string => new Date(now.getTime() - 4 * 3600_000).toISOString().slice(0, 10);

/** Importe en unidades menores (BOB) de «Bs 1.000,00». */
export const BOB = (bolivianos: number): number => bolivianos * 100;

export interface LedgerLine {
  readonly direction: 'debit' | 'credit';
  readonly amount_minor: number;
  readonly business_ref: string;
  readonly counterparty_account: string;
  readonly code: string;
}

/** Saldo, extracto y asientos de `pay-ledger` REAL vistos con la identidad de `pay-payments` (solo lectura). */
export function ledgerReader(stack: Stack) {
  const get = (path: string) => stack.callAs('pay-payments', 'pay-ledger', 'GET', path, { payMode: 'test' });
  return {
    /** Una cuenta que nadie nombró todavía no existe (la crea el ledger al primer asiento): su saldo es 0. */
    async balance(account: string): Promise<number> {
      const res = await get(`/balances?account=${encodeURIComponent(account)}`);
      if (res.status === 404) return 0;
      if (res.status !== 200) throw new Error(`GET /balances?account=${account} respondió ${res.status}`);
      return (res.json as { balance_minor: number }).balance_minor;
    },
    async statement(account: string): Promise<LedgerLine[]> {
      const res = await get(`/statements?account=${encodeURIComponent(account)}&limit=100`);
      if (res.status === 404) return [];
      if (res.status !== 200) throw new Error(`GET /statements?account=${account} respondió ${res.status}`);
      return (res.json as { data: LedgerLine[] }).data;
    },
  };
}

/**
 * [DOBLE] Asiento de apertura sintético: acredita `amountMinor` en `merchant:{merchantId}:available`. `reference` distingue cada carga
 * (la misma referencia repetida es idempotente: `exists`). `reference` es el verbo del `business_ref` del ledger
 * (`<comercio>:<verbo>`, solo minúsculas y `_`, 3–30 caracteres). Devuelve el id `tx_…` del asiento.
 */
export async function fundWallet(stack: Stack, merchantId: string, amountMinor: number, reference: string): Promise<string> {
  const res = await stack.callAs('pay-payments', 'pay-ledger', 'POST', '/transactions', {
    merchantId,
    payMode: 'test',
    headers: { 'idempotency-key': `e5-${merchantId}-${reference}-1` },
    json: {
      business_ref: `${merchantId}:${reference}`,
      attempt: 1,
      currency: 'BOB',
      legs: [{ debit_account: 'connector:mock:clearing', credit_account: `merchant:${merchantId}:available`, amount_minor: amountMinor, code: 'adjustment' }],
    },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`El asiento de apertura sintético falló (${res.status}): ${res.text}`);
  return (res.json as { id: string }).id;
}

/** Una conexión de solo lectura a la base de `pay-schedules` del stack (rol propio del servicio, igual que la siembra de `seed.ts`). */
export async function scheduleDb<T>(stack: Stack, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: 'pay_schedules', user: 'pay_schedules', password: 'dev_only_schedules' });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

export interface ScheduledPaymentRow {
  readonly id: string;
  readonly mandate_id: string;
  readonly period: string;
  readonly status: string;
  readonly phase: string;
  readonly attempts: number;
  readonly ledger_attempt: number;
  readonly hold_id: string | null;
  readonly ledger_transaction_id: string | null;
  readonly needs_review: boolean;
  readonly last_failure_code: string | null;
}

export const scheduledPaymentsOf = (stack: Stack, mandateId: string): Promise<ScheduledPaymentRow[]> =>
  scheduleDb(stack, async (client) => {
    const { rows } = await client.query(
      'SELECT id, mandate_id, period, status, phase, attempts, ledger_attempt, hold_id, ledger_transaction_id, needs_review, last_failure_code FROM scheduled_payments WHERE mandate_id = $1 ORDER BY period, id',
      [mandateId],
    );
    return rows as ScheduledPaymentRow[];
  });

/**
 * [DOBLE DEL RELOJ] Los días 29, 30 y 31 el día del mes de un mandato no puede ser el de hoy (el contrato admite 1–28), así que el primer
 * vencimiento cae el mes siguiente y el ejecutor no lo tocaría. Para que el flujo sea el mismo cualquier día del mes, si el primer
 * vencimiento todavía no llegó se adelanta a HOY en la fila del mandato. Devuelve `true` si hubo que adelantarlo (el flujo lo declara).
 */
export const makeMandateDueToday = (stack: Stack, mandateId: string): Promise<boolean> =>
  scheduleDb(stack, async (client) => {
    const res = await client.query(`UPDATE mandates SET next_run_on = $2::date WHERE id = $1 AND status = 'active' AND next_run_on > $2::date`, [mandateId, laPazToday()]);
    return (res.rowCount ?? 0) > 0;
  });

/** Espera (por condición) a que la réplica de comercios de `pay-schedules` conozca a todos como `active` (llegan por NATS desde `pay-merchants`). */
export const waitForReplica = (stack: Stack, merchantIds: readonly string[], timeoutMs = 30_000) =>
  waitFor(
    () =>
      scheduleDb(stack, async (client) => {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM merchant_replica WHERE merchant_id = ANY($1) AND status = 'active'`, [merchantIds]);
        return (rows[0] as { n: number }).n === merchantIds.length;
      }),
    timeoutMs,
  );

export interface ExtraExecutors {
  readonly pids: readonly number[];
  /** Apaga los procesos extra y devuelve los PID que sigan vivos (debería ser vacío). */
  stop(): Promise<number[]>;
}

/**
 * Levanta `count` procesos REALES de `pay-schedules` más, con el mismo entorno que el del stack (misma base, mismo ledger, mismo NATS) y su
 * propio puerto y log. Con el del stack suman `count + 1` ejecutores compitiendo por los mismos pagos (arriendos `SKIP LOCKED` y
 * `UNIQUE (mandate_id, period)`). `overrides` debe ser el MISMO que se le dio al del stack en `startStack({ envOverrides })`.
 */
export async function startExtraExecutors(stack: Stack, count: number, overrides: Record<string, string>): Promise<ExtraExecutors> {
  const ports = await freePorts(count);
  const ctx: EnvContext = {
    runId: stack.runId,
    ports: Object.fromEntries(SERVICES.map((name) => [name, stack.services[name].port])) as EnvContext['ports'],
    infra: stack.infra,
    secrets: stack.secrets,
    receiverPort: stack.receiver.port,
    receiverCaFile: stack.receiver.certFile,
    kycDir: join(stack.runDir, 'kyc'),
  };
  const started: Managed[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const env = { ...envFor(ctx, 'pay-schedules'), ...overrides, PORT: String(ports[i]) };
      started.push(spawnNode(`pay-schedules#${i + 2}`, join(ROOT, 'services', 'pay-schedules'), 'dist/main.js', env, join(stack.runDir, `pay-schedules-extra-${i + 2}.log`)));
    }
    await Promise.all(
      started.map(async (managed, i) => {
        const ready = await waitFor(
          async () => (await fetch(`http://127.0.0.1:${ports[i]}/health/ready`, { signal: AbortSignal.timeout(2000) })).status === 200,
          60_000,
          () => (managed.exit ? `el ejecutor extra ${i + 2} terminó (código ${managed.exit.code ?? managed.exit.signal}) antes de quedar listo` : undefined),
        );
        if (!ready.ok) throw new Error(`El ejecutor extra ${i + 2} no quedó listo: ${ready.reason}`);
      }),
    );
  } catch (error) {
    await Promise.all(started.map((managed) => terminate(managed)));
    throw error;
  }
  return {
    pids: started.map((managed) => managed.pid),
    async stop() {
      await Promise.all(started.map((managed) => terminate(managed)));
      return started.filter((managed) => isOurProcess(managed.pid, 'services/pay-schedules')).map((managed) => managed.pid);
    },
  };
}
