import { readFileSync } from 'node:fs';
import { SERVICES, type ServiceName } from './services.ts';
import { startStack, stopStack } from '../stack.ts';

export interface LiveGuardResult {
  readonly service: ServiceName;
  readonly started: boolean;
  readonly healthy: boolean;
  /** El registro completo del proceso (no solo la cola): ahí está el mensaje de la guardia. */
  readonly log: string;
}

/**
 * P1.H5.M5 en pequeño: arranca los servicios pedidos con `PAY_MODE=live` y el RESTO del entorno de sandbox intacto (conector `mock`,
 * `VAULT_BACKEND=fake`, destinos y CA de sandbox, rail `mock` de liquidación…). Una guardia correcta hace que el proceso termine
 * con un mensaje que nombra el modo; un servicio que queda sano está sirviendo `live` con dobles.
 */
export async function bootUnderLive(only: readonly ServiceName[] = SERVICES, extraEnv: Partial<Record<ServiceName, Record<string, string | null>>> = {}): Promise<LiveGuardResult[]> {
  // IDEMPOTENCY_MASK_KEY (≥32 bytes, S-02) es obligatoria bajo live: se le da una SINTÉTICA a todos para que cada caso mida SU guardia y no la falta de esta; un caso puede quitarla con `null`.
  const envOverrides = Object.fromEntries(only.map((name) => [name, { PAY_MODE: 'live', IDEMPOTENCY_MASK_KEY: 'clave-sintetica-de-prueba-0123456789abcdef', ...extraEnv[name] }]));
  const stack = await startStack({ only, envOverrides, readyTimeoutMs: 25_000 });
  let results: LiveGuardResult[] = [];
  let leftover: readonly number[] = [];
  try {
    results = only.map((service) => {
      const status = stack.services[service];
      const log = status.logFile ? readFileSync(status.logFile, 'utf8') : '';
      return { service, started: status.started, healthy: status.healthy, log };
    });
  } finally {
    leftover = (await stopStack(stack, { keepLogs: false })).leftoverPids;
  }
  if (leftover.length > 0) throw new Error(`Procesos que no cerraron: ${leftover.join(', ')}`);
  return results;
}

/** Una guardia que funciona: el servicio no llegó a estar sano y el motivo nombra el modo (no un fallo cualquiera). */
export function refusedLive(result: LiveGuardResult): boolean {
  return !result.healthy && /PAY_MODE\s*=\s*live/.test(result.log);
}
