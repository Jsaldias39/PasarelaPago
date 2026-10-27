/** Configuración propia de pay-ledger (la genérica está en ../config.ts). Falla al arrancar si falta lo obligatorio. */
export interface LedgerConfig {
  readonly tb: { readonly address: string; readonly clusterId: bigint; readonly timeoutMs: number };
  /** 0 = el job del invariante no corre solo (se puede invocar a mano). */
  readonly invariantIntervalMs: number;
  /** 0 = el barrido de retenciones vencidas no corre solo. */
  readonly holdSweepIntervalMs: number;
  /** Margen sobre `expires_at` antes de dar una retención por vencida (reloj de Postgres contra el de TigerBeetle). */
  readonly holdExpirySkewMs: number;
  /**
   * Sufijo que aparta los ids de TigerBeetle de este despliegue de los de otro que comparta el mismo cluster (por ejemplo, pruebas de
   * integración de otros servicios). Vacío en producción: cambiarlo en un ledger con datos huérfana el dinero ya registrado.
   */
  readonly idNamespace: string;
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
    tb: { address, clusterId: BigInt(integer(env, 'TB_CLUSTER_ID', 0, 0)), timeoutMs: integer(env, 'TB_TIMEOUT_MS', 8000, 100) },
    invariantIntervalMs: integer(env, 'LEDGER_INVARIANT_INTERVAL_MS', 0, 0),
    holdSweepIntervalMs: integer(env, 'LEDGER_HOLD_SWEEP_INTERVAL_MS', 0, 0),
    holdExpirySkewMs: integer(env, 'LEDGER_HOLD_EXPIRY_SKEW_MS', 2000, 0),
    idNamespace: idNamespace(env.LEDGER_ID_NAMESPACE),
  };
}

function idNamespace(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new Error('LEDGER_ID_NAMESPACE inválido: 1 a 40 caracteres [A-Za-z0-9_-]');
  return raw;
}
