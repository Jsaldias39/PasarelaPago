/** Configuración propia de pay-settlement (la genérica está en ../config.ts). Falla al arrancar si falta lo obligatorio o es peligroso. */
export type SettlementMode = 'bank' | 'acquirer';
export type PayMode = 'sandbox' | 'live';

export interface SettlementConfig {
  readonly ledgerUrl: string;
  readonly connectorsUrl: string;
  readonly httpTimeoutMs: number;
  /** Conector por el que salen los payouts del modo A: `mock` en sandbox, `bank_transfer` en producción (override: `SETTLEMENT_TRANSFER_CONNECTOR`). */
  readonly transferConnector: 'mock' | 'mercantil_qr' | 'mercantil_card' | 'bank_transfer';
  /** `settlement.mode`: `bank` = modo A (D-02, rail real); `acquirer` = modo B (rail doble declarado). */
  readonly mode: SettlementMode;
  readonly payMode: PayMode;
  /** Día del corte (0 = domingo … 6 = sábado). `null` = sin restricción. D-19: lunes. */
  readonly cutoffWeekday: number | null;
  /** Huso del comercio en minutos respecto de UTC (Bolivia: −240, sin horario de verano). El corte es a las 00:00 locales. */
  readonly tzOffsetMinutes: number;
  readonly releaseDays: number;
  /** Cuánto dura la retención de un payout. Tiene que cubrir el tiempo en tránsito del riel bancario. */
  readonly payoutHoldTtlSeconds: number;
  /** 0 = el barrido de payouts y corridas no corre solo. */
  readonly sweepIntervalMs: number;
  /** Margen antes de que el barrido retome un payout o corrida que quedó a medias. */
  readonly stuckAfterMs: number;
  /** Formato en que cada conector entrega el extracto (`SETTLEMENT_STATEMENT_FORMATS=mercantil_qr:camt053,bank_transfer:csv`); el resto, JSON. */
  readonly statementFormats: Readonly<Record<string, 'json' | 'camt053' | 'csv'>>;
  /** Emitir `mode` en `settlement.batch.closed` y `reconciliation.exception.opened`. Apagado hasta que el AsyncAPI lo declare (ver `event-mode.ts`). */
  readonly eventsCarryMode: boolean;
  readonly operator: { readonly publicKeyPem: string; readonly issuer: string; readonly audience: string };
}

export const SETTLEMENT_CONFIG = Symbol('SETTLEMENT_CONFIG');

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocolo');
  } catch {
    throw new Error(`${name} inválido: tiene que ser una URL http(s)`);
  }
  return value.replace(/\/+$/, '');
}

export function loadSettlementConfig(env: NodeJS.ProcessEnv = process.env): SettlementConfig {
  const rawMode = env.SETTLEMENT_MODE ?? 'bank';
  if (rawMode !== 'bank' && rawMode !== 'acquirer') throw new Error(`SETTLEMENT_MODE inválido: ${rawMode} (bank | acquirer)`);
  const rawPay = env.PAY_MODE ?? 'sandbox';
  if (rawPay !== 'sandbox' && rawPay !== 'live') throw new Error(`PAY_MODE inválido: ${rawPay} (sandbox | live)`);
  // El riel del modo B es un doble: «paga» sin mover dinero. En producción marcaría como pagado un pago que nunca salió.
  if (rawPay === 'live' && rawMode === 'acquirer') {
    throw new Error('SETTLEMENT_MODE=acquirer es un doble declarado (D-02) y no puede correr con PAY_MODE=live');
  }
  const weekday = env.SETTLEMENT_CUTOFF_WEEKDAY;
  return {
    ledgerUrl: url(env, 'LEDGER_URL'),
    connectorsUrl: url(env, 'CONNECTORS_URL'),
    httpTimeoutMs: integer(env, 'SETTLEMENT_HTTP_TIMEOUT_MS', 8000, 100),
    transferConnector: transferConnector(env.SETTLEMENT_TRANSFER_CONNECTOR, rawPay),
    mode: rawMode,
    payMode: rawPay,
    cutoffWeekday: weekday === undefined || weekday === '' ? 1 : weekday === 'any' ? null : integer(env, 'SETTLEMENT_CUTOFF_WEEKDAY', 1, 0, 6),
    tzOffsetMinutes: integer(env, 'SETTLEMENT_TZ_OFFSET_MINUTES', -240, -720, 840),
    releaseDays: integer(env, 'SETTLEMENT_RELEASE_DAYS', 7, 0, 60),
    payoutHoldTtlSeconds: integer(env, 'SETTLEMENT_PAYOUT_HOLD_TTL_SECONDS', 7 * 86_400, 60, 2_592_000),
    sweepIntervalMs: integer(env, 'SETTLEMENT_SWEEP_INTERVAL_MS', 0, 0),
    stuckAfterMs: integer(env, 'SETTLEMENT_STUCK_AFTER_MS', 60_000, 0),
    statementFormats: statementFormats(env.SETTLEMENT_STATEMENT_FORMATS),
    eventsCarryMode: flag(env, 'EVENTS_CARRY_MODE'),
    operator: {
      publicKeyPem: required(env, 'OPERATOR_TOKEN_PUBLIC_KEY').replace(/\\n/g, '\n'),
      issuer: required(env, 'OPERATOR_TOKEN_ISSUER'),
      audience: required(env, 'OPERATOR_TOKEN_AUDIENCE'),
    },
  };
}

function statementFormats(raw: string | undefined): Record<string, 'json' | 'camt053' | 'csv'> {
  const out: Record<string, 'json' | 'camt053' | 'csv'> = {};
  for (const pair of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [connector, format] = pair.split(':');
    if (!connector || (format !== 'json' && format !== 'camt053' && format !== 'csv')) throw new Error(`SETTLEMENT_STATEMENT_FORMATS inválido: ${pair}`);
    out[connector] = format;
  }
  return out;
}

function transferConnector(raw: string | undefined, payMode: PayMode): SettlementConfig['transferConnector'] {
  if (raw === undefined || raw === '') return payMode === 'sandbox' ? 'mock' : 'bank_transfer';
  if (raw !== 'mock' && raw !== 'mercantil_qr' && raw !== 'mercantil_card' && raw !== 'bank_transfer') throw new Error(`SETTLEMENT_TRANSFER_CONNECTOR inválido: ${raw}`);
  if (raw === 'mock' && payMode === 'live') throw new Error('SETTLEMENT_TRANSFER_CONNECTOR=mock no puede correr con PAY_MODE=live');
  return raw;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} inválido: ${raw} (true | false)`);
}
