/** Configuración propia de pay-ledger (la genérica está en ../config.ts). Falla al arrancar si falta lo obligatorio. */
import type { DeploymentMode } from './mode';

export interface LedgerConfig {
  /** `PAY_MODE` (D-26): obligatorio, SIN valor por defecto. Fija con qué modo de clave opera este despliegue (sandbox↔test, live↔live). */
  readonly payMode: DeploymentMode;
  readonly tb: { readonly address: string; readonly clusterId: bigint; readonly timeoutMs: number };
  /** 0 = el job del invariante no corre solo (se puede invocar a mano). */
  readonly invariantIntervalMs: number;
  /** 0 = el barrido de retenciones vencidas no corre solo. */
  readonly holdSweepIntervalMs: number;
  /** Cada cuánto el reconciliador compara TigerBeetle con Postgres (`reconciler.service.ts`). 0 = solo al arrancar (si `reconcileOnStart`) o a mano. */
  readonly reconcileIntervalMs: number;
  /** Recorrer también al arrancar el servicio. */
  readonly reconcileOnStart: boolean;
  /** Cuánto hacia atrás mira cada recorrido, en ms. 0 = toda la historia. */
  readonly reconcileLookbackMs: number;
  /** Lo más reciente que no se mira (en ms): puede estar a mitad de camino entre TigerBeetle y Postgres. */
  readonly reconcileGraceMs: number;
  /** Margen sobre `expires_at` antes de dar una retención por vencida (reloj de Postgres contra el de TigerBeetle). */
  readonly holdExpirySkewMs: number;
  /**
   * Sufijo que aparta los ids de TigerBeetle de este despliegue de los de otro que comparta el mismo cluster (por ejemplo, pruebas de
   * integración de otros servicios). Vacío en producción: cambiarlo en un ledger con datos huérfana el dinero ya registrado.
   */
  readonly idNamespace: string;
  /** Emitir `mode` en los datos de los eventos `ledger.*`. Apagado hasta que el AsyncAPI lo declare (ver `event-mode.ts`). */
  readonly eventsCarryMode: boolean;
}

export const LEDGER_CONFIG = Symbol('LEDGER_CONFIG');

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

export function loadLedgerConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig {
  const address = env.TB_ADDRESS;
  if (!address) throw new Error('Falta la variable de entorno TB_ADDRESS');
  return {
    payMode: payMode(env.PAY_MODE),
    tb: { address, clusterId: BigInt(integer(env, 'TB_CLUSTER_ID', 0, 0)), timeoutMs: integer(env, 'TB_TIMEOUT_MS', 8000, 100) },
    invariantIntervalMs: integer(env, 'LEDGER_INVARIANT_INTERVAL_MS', 0, 0),
    holdSweepIntervalMs: integer(env, 'LEDGER_HOLD_SWEEP_INTERVAL_MS', 0, 0),
    holdExpirySkewMs: integer(env, 'LEDGER_HOLD_EXPIRY_SKEW_MS', 2000, 0),
    reconcileIntervalMs: integer(env, 'LEDGER_RECONCILE_INTERVAL_MS', 300_000, 0),
    reconcileOnStart: flag(env, 'LEDGER_RECONCILE_ON_START', true),
    reconcileLookbackMs: integer(env, 'LEDGER_RECONCILE_LOOKBACK_MS', 7 * 24 * 3600 * 1000, 0),
    reconcileGraceMs: integer(env, 'LEDGER_RECONCILE_GRACE_MS', 120_000, 0),
    idNamespace: idNamespace(env.LEDGER_ID_NAMESPACE),
    eventsCarryMode: flag(env, 'EVENTS_CARRY_MODE'),
  };
}

function idNamespace(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new Error('LEDGER_ID_NAMESPACE inválido: 1 a 40 caracteres [A-Za-z0-9_-]');
  return raw;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} inválido: ${raw} (true | false)`);
}

/** Sin valor por defecto: un despliegue que no dice qué es no arranca (nunca se asume ni `sandbox` ni `live`). */
function payMode(raw: string | undefined): DeploymentMode {
  if (raw === undefined || raw === '') throw new Error('Falta la variable de entorno PAY_MODE (sandbox | live): no tiene valor por defecto');
  if (raw !== 'sandbox' && raw !== 'live') throw new Error(`PAY_MODE inválido: ${raw} (sandbox | live)`);
  return raw;
}
