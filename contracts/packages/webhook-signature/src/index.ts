import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * Firma y verificación de webhooks según Standard Webhooks v1.
 * Spec: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 *
 * - `v1`: HMAC-SHA256, secreto `whsec_` + base64 de 24 a 64 bytes aleatorios.
 * - `v1a`: Ed25519, `whsk_` / `whpk_` + base64. El spec dice «standard ed25519 key pair» sin fijar los
 *   bytes: acá `whpk_` es la clave pública cruda (32 bytes) y `whsk_` la clave secreta de 64 bytes
 *   (semilla ‖ pública, la forma de libsodium y de Go). Al firmar se acepta también una semilla de 32 bytes.
 *
 * El contenido firmado es `${id}.${timestamp}.${payload}`, con el cuerpo byte a byte idéntico al enviado.
 */

export const HEADER_ID = 'webhook-id';
export const HEADER_TIMESTAMP = 'webhook-timestamp';
export const HEADER_SIGNATURE = 'webhook-signature';

/** El spec no fija una ventana; se usa la misma que la librería de referencia. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = 'whsec_';
const SECRET_KEY_PREFIX = 'whsk_';
const PUBLIC_KEY_PREFIX = 'whpk_';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type VerificationFailure =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'no_matching_signature';

/** La verificación falló; `reason` dice por qué sin revelar nada de las claves. */
export class WebhookVerificationError extends Error {
  constructor(readonly reason: VerificationFailure) {
    super(`Webhook inválido: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

export interface SignInput {
  readonly id: string;
  /** Segundos desde la época. */
  readonly timestamp: number;
  readonly payload: string | Buffer;
  /** Secretos simétricos `whsec_...`. Más de uno permite rotar sin corte. */
  readonly secrets?: readonly string[];
  /** Claves secretas asimétricas `whsk_...`. */
  readonly secretKeys?: readonly string[];
}

export interface VerifyInput {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly payload: string | Buffer;
  readonly secrets?: readonly string[];
  /** Lista de confianza de claves públicas `whpk_...`: nunca se lee la clave del propio mensaje. */
  readonly publicKeys?: readonly string[];
  readonly toleranceSeconds?: number;
  /** Segundos desde la época; solo para pruebas. */
  readonly now?: number;
}

/** Genera un secreto simétrico `whsec_...` de `bytes` bytes (24 a 64). */
export function generateSecret(bytes = 32): string {
  if (bytes < 24 || bytes > 64) throw new RangeError('El secreto debe tener entre 24 y 64 bytes');
  return SECRET_PREFIX + randomBytes(bytes).toString('base64');
}

/** Genera un par Ed25519 con las claves serializadas `whsk_...` / `whpk_...`. */
export function generateKeyPair(): { secretKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return {
    secretKey: SECRET_KEY_PREFIX + Buffer.concat([seed, pub]).toString('base64'),
    publicKey: PUBLIC_KEY_PREFIX + pub.toString('base64'),
  };
}

function decodeSecret(secret: string): Buffer {
  const raw = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
  if (raw.length < 24 || raw.length > 64) throw new RangeError('El secreto debe tener entre 24 y 64 bytes');
  return raw;
}

function privateKeyOf(secretKey: string): KeyObject {
  if (!secretKey.startsWith(SECRET_KEY_PREFIX)) throw new RangeError('Clave secreta sin el prefijo whsk_');
  const raw = Buffer.from(secretKey.slice(SECRET_KEY_PREFIX.length), 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new RangeError('La clave secreta Ed25519 debe tener 32 o 64 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}

function publicKeyOf(publicKey: string): KeyObject {
  if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) throw new RangeError('Clave pública sin el prefijo whpk_');
  const raw = Buffer.from(publicKey.slice(PUBLIC_KEY_PREFIX.length), 'base64');
  if (raw.length !== 32) throw new RangeError('La clave pública Ed25519 debe tener 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

function signedContent(id: string, timestamp: number | string, payload: string | Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${id}.${timestamp}.`), Buffer.from(payload)]);
}

/**
 * Firma un mensaje.
 *
 * @returns El valor de la cabecera `webhook-signature`: firmas separadas por espacios.
 */
export function sign(input: SignInput): string {
  const content = signedContent(input.id, input.timestamp, input.payload);
  const signatures = [
    ...(input.secrets ?? []).map((s) => `v1,${createHmac('sha256', decodeSecret(s)).update(content).digest('base64')}`),
    ...(input.secretKeys ?? []).map((k) => `v1a,${edSign(null, content, privateKeyOf(k)).toString('base64')}`),
  ];
  if (signatures.length === 0) throw new RangeError('Hace falta al menos un secreto o una clave secreta');
  return signatures.join(' ');
}

/** Las tres cabeceras listas para enviar. */
export function signedHeaders(input: SignInput): Record<string, string> {
  return {
    [HEADER_ID]: input.id,
    [HEADER_TIMESTAMP]: String(input.timestamp),
    [HEADER_SIGNATURE]: sign(input),
  };
}

function header(headers: VerifyInput['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function equalConstantTime(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifica un mensaje recibido.
 *
 * @throws WebhookVerificationError si falta una cabecera, el timestamp es inválido o está fuera de la
 *   tolerancia, o ninguna firma coincide con ninguno de los secretos o claves públicas de confianza.
 */
export function verify(input: VerifyInput): void {
  const id = header(input.headers, HEADER_ID);
  const rawTimestamp = header(input.headers, HEADER_TIMESTAMP);
  const signatureHeader = header(input.headers, HEADER_SIGNATURE);
  if (!id || !rawTimestamp || !signatureHeader) throw new WebhookVerificationError('missing_headers');
  if (!/^\d{1,12}$/.test(rawTimestamp)) throw new WebhookVerificationError('invalid_timestamp');

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(rawTimestamp)) > tolerance) throw new WebhookVerificationError('timestamp_outside_tolerance');

  const content = signedContent(id, rawTimestamp, input.payload);
  const expectedV1 = (input.secrets ?? []).map((s) => createHmac('sha256', decodeSecret(s)).update(content).digest());
  const publicKeys = (input.publicKeys ?? []).map(publicKeyOf);

  for (const candidate of signatureHeader.split(' ')) {
    const comma = candidate.indexOf(',');
    if (comma < 0) continue;
    const version = candidate.slice(0, comma);
    const signature = Buffer.from(candidate.slice(comma + 1), 'base64');
    if (version === 'v1' && expectedV1.some((expected) => equalConstantTime(expected, signature))) return;
    if (version === 'v1a' && publicKeys.some((key) => edVerify(null, content, key, signature))) return;
  }
  throw new WebhookVerificationError('no_matching_signature');
}
