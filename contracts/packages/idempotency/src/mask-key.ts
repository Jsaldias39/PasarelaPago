/**
 * Clave de servidor con la que se enmascara una `Idempotency-Key` con forma de PAN (HMAC-SHA-256, ver `safeIdempotencyKey`).
 *
 * POR QUÉ UNA CLAVE: un hash SIN clave de un valor con espacio de búsqueda chico (BIN conocido + Luhn ≈ 10^9 candidatos) se invierte por enumeración: la revisión de
 * seguridad (S-02) recuperó un PAN de prueba del valor guardado en 1,1 s. Con HMAC y una clave que NO está en la base ni en el repo, quien lea `idempotency_keys`
 * (o un volcado) no puede enumerar. Sigue siendo DETERMINISTA: la misma clave de entrada da el mismo valor mientras no cambie `IDEMPOTENCY_MASK_KEY`.
 *
 * DE DÓNDE SALE (`IDEMPOTENCY_MASK_KEY`):
 * - Bajo `PAY_MODE=live` es OBLIGATORIA, de al menos 32 bytes, y NO puede ser la constante de desarrollo. Se valida al arrancar: `IdempotencyStore` la comprueba en su
 *   constructor y pay-edge en `loadConfig`. Va a la gestión de secretos del despliegue (OpenBao), nunca al repositorio.
 * - Con `PAY_MODE=sandbox` (o sin definir: pruebas) y SIN la variable se usa {@link DEV_MASK_KEY}, una constante DECLARADA. Se eligió una constante y no un valor aleatorio
 *   por proceso porque la idempotencia tiene que sobrevivir a un reinicio y valer entre las réplicas y entre servicios (pay-edge enmascara y los dueños vuelven a pasar la
 *   clave por el mismo filtro): con una clave distinta por proceso, el reintento de un comercio tras un reinicio ejecutaría la operación dos veces. El costo es que en
 *   sandbox el enmascarado NO protege (la clave es pública): es aceptable porque el sandbox solo maneja números de tarjeta de prueba públicos (D-26) y `live` la prohíbe.
 * - Cualquier `PAY_MODE` que no sea vacío ni `sandbox` (incluido un typo) se trata como `live`: nunca se cae a la constante por un modo mal escrito.
 *
 * ROTACIÓN: cambiar la clave cambia el valor guardado de una clave de idempotencia con forma de PAN. Las filas vencen a las 24 h (`ttlMs`), así que rotar solo puede
 * duplicar, durante esa ventana, la ejecución de un reintento de un comercio que pegó un PAN como clave (caso anómalo); no hay migración de filas.
 */
import { createHmac } from 'node:crypto';

export const MASK_KEY_ENV = 'IDEMPOTENCY_MASK_KEY';
export const MIN_MASK_KEY_BYTES = 32;
/** Constante de DESARROLLO, pública a propósito (ver arriba). El prefijo `dev-only-` hace que `live` la rechace. */
export const DEV_MASK_KEY = 'dev-only-idempotency-mask-key-sandbox-0123456789';

const isDevMode = (env: NodeJS.ProcessEnv): boolean => env.PAY_MODE === undefined || env.PAY_MODE === '' || env.PAY_MODE === 'sandbox';

/**
 * Devuelve la clave de enmascarado o lanza si la configuración no es válida. No repite el valor de la clave en el mensaje.
 * @throws Error `IDEMPOTENCY_MASK_KEY` ausente bajo live, de menos de 32 bytes, o de desarrollo bajo live.
 */
export function resolveMaskKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[MASK_KEY_ENV];
  if (raw === undefined || raw === '') {
    if (isDevMode(env)) return Buffer.from(DEV_MASK_KEY, 'utf8');
    throw new Error(`${MASK_KEY_ENV} es obligatoria bajo PAY_MODE=live (mínimo ${MIN_MASK_KEY_BYTES} bytes, secreto de despliegue): sin ella una Idempotency-Key con forma de PAN no se puede enmascarar`);
  }
  const key = Buffer.from(raw, 'utf8');
  if (key.length < MIN_MASK_KEY_BYTES) throw new Error(`${MASK_KEY_ENV} inválida: mide ${key.length} bytes y el mínimo es ${MIN_MASK_KEY_BYTES}`);
  if (!isDevMode(env) && raw.startsWith('dev-only-')) throw new Error(`${MASK_KEY_ENV} inválida: bajo PAY_MODE=live no se admite la clave de desarrollo`);
  return key;
}

/** Validación de arranque: lanza si `resolveMaskKey` lanzaría. Pensada para el `loadConfig` de cada servicio. */
export function assertIdempotencyMaskConfig(env: NodeJS.ProcessEnv = process.env): void {
  resolveMaskKey(env);
}

/** HMAC-SHA-256 (hex) de `text` con la clave de servidor. Determinista para una misma clave. */
export function maskDigest(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac('sha256', resolveMaskKey(env)).update(text, 'utf8').digest('hex');
}
