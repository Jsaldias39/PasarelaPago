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
export async function bootUnderLive(only: readonly ServiceName[] = SERVICES, extraEnv: Partial<Record<ServiceName, Record<string, string>>> = {}): Promise<LiveGuardResult[]> {
  const envOverrides = Object.fromEntries(only.map((name) => [name, { PAY_MODE: 'live', ...extraEnv[name] }]));
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
