import { BlockList, isIP } from 'node:net';

/**
 * Política de endpoint de callbacks: ruta registrada y activa, red de origen y ventana de repetición.
 *
 * PROCEDENCIA: adaptado de `mdavila-2001/mantra-core-health-api`, `src/modules/payments/services/callback-endpoint.policy.ts`
 * (origin/dev @ 4e64353a). Cambios: los motivos de rechazo son cadenas estables propias (no `PaymentsErrorReason`) y el
 * estado «activo» es un booleano en vez de un concepto codificado. La lógica (fail-closed) es la misma.
 */
export interface CallbackEndpointRecord {
  readonly callbackPath: string;
  readonly active: boolean;
  /** Redes de origen permitidas (CIDR o IP); vacío o ausente = sin restricción. */
  readonly allowedSourceCidrs?: unknown;
  /** Ventana de repetición en segundos; ausente = sin ventana. */
  readonly replayWindowSeconds?: number | null;
}

export interface CallbackContext {
  readonly callbackPath: string;
  /** IP de origen resuelta por el servidor (nunca una cabecera que mande el proveedor). */
  readonly sourceIp?: string;
  /** Timestamp firmado del callback, si el proveedor lo envió. */
  readonly timestamp?: string;
  readonly now: Date;
}

export type CallbackEndpointDecision =
  | { readonly allowed: true; readonly enforced: boolean }
  | { readonly allowed: false; readonly reason: 'endpoint_not_allowed' | 'source_not_allowed' | 'outside_replay_window' };

/** `::ffff:1.2.3.4` es la IPv4 `1.2.3.4` vista desde un socket dual-stack. */
function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '');
}

/** Si `ip` cae en alguna de las redes. Fail-closed: una entrada que no es IP ni CIDR válido invalida la lista entera. */
function ipInCidrs(ip: string | undefined, cidrs: unknown): boolean {
  if (!ip || !Array.isArray(cidrs)) return false;
  const address = normalizeIp(ip);
  const family = isIP(address);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of cidrs) {
    if (typeof entry !== 'string') return false;
    const [network, prefixText] = entry.trim().split('/');
    const networkFamily = isIP(network);
    if (networkFamily === 0) return false;
    const type = networkFamily === 4 ? 'ipv4' : 'ipv6';
    if (prefixText === undefined) {
      list.addAddress(network, type);
      continue;
    }
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || prefix < 0 || prefix > (networkFamily === 4 ? 32 : 128)) return false;
    list.addSubnet(network, prefix, type);
  }
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Contrasta un callback ya autenticado con los endpoints registrados del conector.
 * Sin endpoints registrados no hay configuración que aplicar (`enforced: false`); con endpoints, la ruta debe ser la de uno
 * ACTIVO, la IP de origen debe estar en sus redes (si las declara) y el timestamp firmado dentro de la ventana (si la declara).
 */
export function evaluateCallbackEndpoint(endpoints: readonly CallbackEndpointRecord[], context: CallbackContext): CallbackEndpointDecision {
  if (endpoints.length === 0) return { allowed: true, enforced: false };
  const endpoint = endpoints.find((e) => e.callbackPath === context.callbackPath && e.active);
  if (!endpoint) return { allowed: false, reason: 'endpoint_not_allowed' };

  const cidrs = endpoint.allowedSourceCidrs;
  const restrictsSource = cidrs !== null && cidrs !== undefined && !(Array.isArray(cidrs) && cidrs.length === 0);
  if (restrictsSource && !ipInCidrs(context.sourceIp, cidrs)) return { allowed: false, reason: 'source_not_allowed' };

  const windowSeconds = endpoint.replayWindowSeconds;
  if (windowSeconds && windowSeconds > 0) {
    const sentAt = context.timestamp ? Number(context.timestamp) * 1000 : NaN;
    if (!Number.isFinite(sentAt) || Math.abs(context.now.getTime() - sentAt) > windowSeconds * 1000) {
      return { allowed: false, reason: 'outside_replay_window' };
    }
  }
  return { allowed: true, enforced: true };
}
