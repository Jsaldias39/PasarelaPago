import type { UpstreamName } from './config';

/**
 * Tabla de rutas públicas de pay-edge. Es una copia en código de `contracts/openapi/public-v1.yaml` (el servicio no lee
 * el YAML en ejecución): `test/routes.spec.ts` falla si una operación del contrato no está acá, si sobra una, o si la
 * obligatoriedad de `Idempotency-Key` o los parámetros de consulta difieren del contrato.
 */
export type Method = 'GET' | 'POST' | 'DELETE';

export interface RouteRule {
  readonly method: Method;
  /** Plantilla del contrato, por ejemplo `/payment_intents/{id}`. */
  readonly template: string;
  readonly upstream: UpstreamName;
  /** El contrato declara `Idempotency-Key` obligatoria. */
  readonly idempotencyKey: boolean;
  /** Parámetros de consulta que el contrato admite; cualquier otro se rechaza. */
  readonly query: readonly string[];
}

const LIST = ['limit', 'starting_after'] as const;

export const ROUTES: readonly RouteRule[] = [
  { method: 'POST', template: '/payment_intents', upstream: 'pay-payments', idempotencyKey: true, query: [] },
  { method: 'GET', template: '/payment_intents', upstream: 'pay-payments', idempotencyKey: false, query: [...LIST, 'status', 'created_from', 'created_to'] },
  { method: 'GET', template: '/payment_intents/{id}', upstream: 'pay-payments', idempotencyKey: false, query: [] },
  { method: 'POST', template: '/payment_intents/{id}/cancel', upstream: 'pay-payments', idempotencyKey: true, query: [] },
  { method: 'POST', template: '/payment_intents/{id}/refunds', upstream: 'pay-payments', idempotencyKey: true, query: [] },
  { method: 'GET', template: '/merchants/me', upstream: 'pay-merchants', idempotencyKey: false, query: [] },
  { method: 'POST', template: '/api_keys', upstream: 'pay-merchants', idempotencyKey: true, query: [] },
  { method: 'GET', template: '/api_keys', upstream: 'pay-merchants', idempotencyKey: false, query: [] },
  { method: 'POST', template: '/api_keys/{id}/rotate', upstream: 'pay-merchants', idempotencyKey: true, query: [] },
  { method: 'DELETE', template: '/api_keys/{id}', upstream: 'pay-merchants', idempotencyKey: false, query: [] },
  { method: 'POST', template: '/webhook_endpoints', upstream: 'pay-webhooks', idempotencyKey: true, query: [] },
  { method: 'GET', template: '/webhook_endpoints', upstream: 'pay-webhooks', idempotencyKey: false, query: [] },
  { method: 'POST', template: '/webhook_endpoints/{id}/rotate_secret', upstream: 'pay-webhooks', idempotencyKey: true, query: [] },
  { method: 'DELETE', template: '/webhook_endpoints/{id}', upstream: 'pay-webhooks', idempotencyKey: false, query: [] },
  { method: 'GET', template: '/balance', upstream: 'pay-ledger', idempotencyKey: false, query: [] },
  { method: 'GET', template: '/payouts', upstream: 'pay-settlement', idempotencyKey: false, query: [...LIST] },
  { method: 'POST', template: '/mandates', upstream: 'pay-schedules', idempotencyKey: true, query: [] },
  { method: 'GET', template: '/mandates', upstream: 'pay-schedules', idempotencyKey: false, query: [...LIST] },
  { method: 'DELETE', template: '/mandates/{id}', upstream: 'pay-schedules', idempotencyKey: false, query: [] },
];

/** Un id de recurso: minúsculas, dígitos, guion bajo y guion; nada de `.`, `%` ni `/` (sin recorrido de rutas ni contrabando). */
const ID = '[a-z0-9_-]{1,64}';

interface Compiled extends RouteRule {
  readonly pattern: RegExp;
}

const COMPILED: readonly Compiled[] = ROUTES.map((route) => ({
  ...route,
  pattern: new RegExp(`^${route.template.replace('{id}', `(${ID})`)}$`),
}));

export interface MatchedRoute {
  readonly rule: RouteRule;
  /** Ruta que se envía al servicio dueño, reconstruida desde la plantilla (no la cruda del cliente). */
  readonly path: string;
}

/**
 * Busca la regla de una petición.
 *
 * @param method - Método HTTP.
 * @param path - Ruta SIN el prefijo `/v1` y sin consulta.
 */
export function matchRoute(method: string, path: string): MatchedRoute | undefined {
  for (const route of COMPILED) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) return { rule: route, path: route.template.replace('{id}', match[1] ?? '') };
  }
  return undefined;
}
