/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Siempre `sandbox`: este servicio NO existe en `live` (D-26), `loadConfig` lo rechaza. */
  readonly mode: 'sandbox';
  /** Secreto con el que el banco simulado firma sus callbacks (Standard Webhooks). SINTÉTICO; en el entorno de pruebas es el mismo que verifica `pay-connectors`. */
  readonly webhookSecret: string;
  /** A dónde entrega los callbacks (el endpoint `POST /callbacks/mock` de `pay-connectors`). Sin URL no entrega ninguno: el cobro se resuelve por consulta de estado. */
  readonly callbackUrl?: string;
  /** Cada cuántos ms el servicio entrega los callbacks vencidos (0 = no lo hace solo: las pruebas lo disparan con `POST /sandbox/admin/deliver`). */
  readonly deliveryIntervalMs: number;
  /** Demora del escenario «demorado» (centavos 02) y de las transferencias en tránsito. */
  readonly delayMs: number;
  /** Cuánto «cuelga» el banco antes de cortar en los escenarios de timeout ambiguo (07). El cliente vence antes por su propio timeout. */
  readonly hangMs: number;
  /** `auto`: el banco «paga» cada QR según su escenario en cuanto lo recibe. `manual`: el QR queda abierto hasta que el pagador simulado lo paga (`mockbank pay`). */
  readonly payerMode: 'auto' | 'manual';
  /** URL base de `pay-qr`, para que el pagador simulado decodifique el QR que paga. */
  readonly qrUrl?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

/**
 * `PAY_MODE` es obligatorio. El banco simulado es un doble: con `live` NO carga y el arranque falla (P4.H4.M5), igual que el conector `mock`.
 * Un valor mal escrito tampoco arranca.
 */
function parseMode(raw: string | undefined): 'sandbox' {
  if (raw === 'sandbox') return 'sandbox';
  if (raw === 'live') throw new Error('PAY_MODE=live: pay-mockbank es un banco simulado y no existe en producción; no arranca');
  throw new Error(`PAY_MODE debe ser sandbox (llegó: ${raw ?? 'sin definir'}); pay-mockbank no existe en live`);
}

function parsePayer(raw: string | undefined): 'auto' | 'manual' {
  if (raw === undefined || raw === '' || raw === 'auto') return 'auto';
  if (raw === 'manual') return 'manual';
  throw new Error(`MOCKBANK_PAYER_MODE debe ser auto o manual (llegó: ${raw})`);
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const mode = parseMode(env.PAY_MODE);
  const port = Number(env.PORT ?? 3112);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT inválido: ${env.PORT}`);
  const dbPort = Number(env.DB_PORT ?? 5432);
  if (!Number.isInteger(dbPort)) throw new Error(`DB_PORT inválido: ${env.DB_PORT}`);
  return {
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      host: required(env, 'DB_HOST'),
      port: dbPort,
      name: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
    },
    mode,
    webhookSecret: required(env, 'MOCKBANK_WEBHOOK_SECRET'),
    ...(env.MOCKBANK_CALLBACK_URL ? { callbackUrl: env.MOCKBANK_CALLBACK_URL } : {}),
    deliveryIntervalMs: integer(env, 'MOCKBANK_DELIVERY_INTERVAL_MS', 500),
    delayMs: integer(env, 'MOCKBANK_DELAY_MS', 5_000, 1),
    hangMs: integer(env, 'MOCKBANK_HANG_MS', 30_000, 1),
    payerMode: parsePayer(env.MOCKBANK_PAYER_MODE),
    ...(env.PAY_QR_URL ? { qrUrl: env.PAY_QR_URL } : {}),
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
