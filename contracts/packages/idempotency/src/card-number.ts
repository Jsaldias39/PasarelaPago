/**
 * ¿El texto lleva un número de tarjeta (PAN)? Regla del repo: el PAN no existe en ningún lado salvo `pay-vault` (CLAUDE.md regla 6). Núcleo COMPARTIDO: lo usan
 * la `Idempotency-Key` (se guarda en claro), el enmascarado de rutas y spans (`url-mask.ts`) y la defensa de cuerpos de pay-edge (`pan-guard.ts`).
 *
 * Cómo se inspecciona (cada punto cierra un modo de esquivarlo):
 * 1. Se normaliza: NFKC (dígitos de ancho completo, matemáticos, superíndices), se quitan los caracteres de formato invisibles (`\p{Cf}`: ancho cero, guion suave,
 *    marcas de dirección) y TODO dígito decimal de cualquier escritura (`\p{Nd}`: árabe-índicos, devanagari, tailandeses…) se lleva a su dígito ASCII.
 * 2. TODO carácter que no sea letra ni dígito (`[^\p{L}\p{N}]`: espacios, `-`, `_`, `.`, `/`, `+`, `:`, `;`, `|`, `,`, `*`, `#`, `~`, emojis, controles…) es un
 *    separador y se colapsa en un espacio ANTES de buscar corridas: ninguno puede partir una corrida para esquivar la prueba.
 * 3. Se toma cada corrida de grupos de dígitos unidos por separadores (de cualquier tipo y largo) y, sobre la SECUENCIA de dígitos, se prueba con Luhn TODA ventana
 *    contigua de 13 a 19 dígitos: un PAN pegado a otros dígitos, antes o después, no se esconde. Cada ventana se resuelve en O(1) con sumas de prefijo por
 *    paridad: costo O(n × 7) aun con 100 KB de dígitos y sin retroceso de expresión regular.
 *
 * COSTO (declarado): cuanto más larga la secuencia de dígitos, más ventanas, así que casi todo número de 20 dígitos o más (y un 25 a 40 % de las claves con una
 * fecha y un correlativo de 14 a 17 dígitos separados por guiones) se marca aunque no sea una tarjeta. Una clave legítima recomendada (UUID, ULID, texto con letras)
 * no lo sufre. LÍMITE: no detecta un PAN partido por LETRAS ni codificado (base64, hexadecimal). No lanza nunca y no devuelve ni conserva ningún fragmento del texto.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { maskDigest } from './mask-key';

const MIN_PAN = 13;
const MAX_PAN = 19;
const FORMAT_CHARS = /\p{Cf}/gu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ALNUM_RUN = /[^\p{L}\p{N}]+/gu;
/** Grupos de dígitos ASCII unidos por UN espacio (los separadores ya se colapsaron en uno). */
const DIGIT_GROUPS = /[0-9]+(?: [0-9]+)*/g;

/** Lleva un dígito decimal Unicode (cualquier escritura) a su dígito ASCII: el valor es la posición dentro de su serie contigua de a 10. */
function asciiDigit(char: string): string {
  if (char >= '0' && char <= '9') return char;
  const code = char.codePointAt(0)!;
  let before = 0;
  while (before < 49 && DECIMAL_DIGIT.test(String.fromCodePoint(code - before - 1))) before += 1;
  return String(before % 10);
}

/** ¿Alguna ventana contigua de 13 a 19 dígitos de esta secuencia cumple Luhn? O(n) con sumas de prefijo por paridad de posición. */
function hasLuhnWindow(digits: string): boolean {
  const n = digits.length;
  if (n < MIN_PAN) return false;
  // plain[x][i]: suma de los dígitos en posiciones j < i con j % 2 == x · doubled[x][i]: lo mismo pero con el dígito duplicado (Luhn)
  const plain = [new Int32Array(n + 1), new Int32Array(n + 1)];
  const doubled = [new Int32Array(n + 1), new Int32Array(n + 1)];
  for (let j = 0; j < n; j += 1) {
    const d = digits.charCodeAt(j) - 48;
    const twice = d * 2 > 9 ? d * 2 - 9 : d * 2;
    for (let x = 0; x < 2; x += 1) {
      plain[x]![j + 1] = plain[x]![j]! + (j % 2 === x ? d : 0);
      doubled[x]![j + 1] = doubled[x]![j]! + (j % 2 === x ? twice : 0);
    }
  }
  for (let end = MIN_PAN; end <= n; end += 1) {
    // En la ventana [start, end) el último dígito pesa 1, el anterior 2, etc.: pesa 1 si j y end-1 tienen la misma paridad.
    const same = (end - 1) % 2;
    for (let length = MIN_PAN; length <= MAX_PAN && length <= end; length += 1) {
      const start = end - length;
      const sum = plain[same]![end]! - plain[same]![start]! + doubled[1 - same]![end]! - doubled[1 - same]![start]!;
      if (sum % 10 === 0) return true;
    }
  }
  return false;
}

export function containsCardNumber(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .replace(FORMAT_CHARS, '')
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(NON_ALNUM_RUN, ' ');
  for (const match of normalized.matchAll(DIGIT_GROUPS)) {
    if (hasLuhnWindow(match[0].replace(/ /g, ''))) return true;
  }
  return false;
}

/**
 * La `Idempotency-Key` que se guarda y se reenvía. Se guarda EN CLARO (`idempotency_keys.key`, 24 h) y viaja en cabeceras: una con forma de número de tarjeta se
 * reemplaza por `masked-<HMAC-SHA-256 de la clave>`: el mismo texto da siempre el mismo valor (la idempotencia sigue funcionando) y el PAN no queda en ninguna parte.
 * El HMAC lleva una clave de SERVIDOR (`IDEMPOTENCY_MASK_KEY`, ver `mask-key.ts`): un SHA-256 sin clave se invertía por enumeración (BIN conocido + Luhn ≈ 10^9, S-02).
 * NO se rechaza: {@link containsCardNumber} tiene falsos positivos con identificadores hexadecimales (una corrida de 13 o más dígitos que cumple Luhn por azar,
 * del orden de 1 de cada 500 claves de 32 hex) y rechazar tiraría peticiones legítimas, además de las claves internas que arma cada servicio (`pi_…:risk`).
 * @throws Error si la clave de enmascarado no es válida (bajo `live`, ausente o corta): falla cerrado, nunca devuelve el PAN ni un hash sin clave.
 */
export function safeIdempotencyKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return containsCardNumber(key) ? `masked-${maskDigest(key, env)}` : key;
}

/** Un id de correlación aceptable: 8 a 64 caracteres sin espacios ni símbolos. */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** ¿Este `X-Request-Id` se puede registrar, devolver y reenviar? Bien formado Y sin forma de PAN (el MISMO detector Luhn que el guardia de cuerpos: {@link containsCardNumber}). */
export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value) && !containsCardNumber(value);
}

/**
 * Un id de correlación NUEVO que {@link isAcceptableRequestId} acepta. Un UUID v4 al azar lleva por casualidad una corrida de dígitos que cumple Luhn en ~0,9 % de los
 * casos (medido: 176 de 20 000): si el id GENERADO por un servicio fuera rechazado por el siguiente, se rompería la correlación de una petición legítima. Por eso un
 * id generado se regenera hasta que pase la MISMA validación que aplican todos los servicios; así un id propio nunca es rechazado aguas abajo.
 * El respaldo (tras 64 intentos, probabilidad ~10^-130) es un id solo de letras: no tiene dígitos, no puede tener forma de PAN.
 */
export function generateRequestId(): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = randomUUID();
    if (isAcceptableRequestId(id)) return id;
  }
  return `req-${randomBytes(18).toString('base64url').replace(/[^A-Za-z]/g, 'x')}`;
}

/**
 * Id de correlación de una petición: el del cliente si viene bien formado y sin forma de PAN; si no, uno generado (S-03). El id se registra como `req.id`, se devuelve en
 * la respuesta y se reenvía, así que un PAN pegado ahí acabaría en los logs de todos los servicios. Lo usa el `genReqId` de pino-http de TODOS los servicios, y los clientes
 * HTTP internos validan con la misma {@link isAcceptableRequestId}. Un id del cliente con una corrida PAN-like se descarta SIEMPRE (también uno con forma de UUID, como
 * `41111111-1111-1111-1111-111111111111`, que el cliente controla): es el comportamiento buscado y es idéntico en toda la cadena.
 */
export function resolveRequestId(incoming: unknown): string {
  return isAcceptableRequestId(incoming) ? incoming : generateRequestId();
}
