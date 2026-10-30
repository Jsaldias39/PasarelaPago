import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** Par RSA SINTÉTICO de las pruebas (no es de nadie) y emisión de credenciales de operador. */
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const PUBLIC_KEY_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
export const OTHER_PUBLIC_KEY_PEM = other.publicKey.export({ type: 'spki', format: 'pem' }) as string;
export const ISSUER = 'pay-sandbox-identity';
export const AUDIENCE = 'pay-merchants';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export interface SignOptions {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  key?: KeyObject;
  omit?: string[];
  nowSeconds?: number;
}

/** Credencial válida por defecto (modo sandbox, rol `merchant_operator`), con cualquier campo alterable para las pruebas negativas. */
export function sign(options: SignOptions = {}): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: ISSUER, aud: AUDIENCE, sub: 'operador_sandbox_01', roles: ['merchant_operator'], mode: 'sandbox', iat: now, exp: now + 3600, ...options.claims };
  for (const name of options.omit ?? []) delete claims[name];
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', ...options.header })}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(options.key ?? pair.privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Firma con la clave de OTRO emisor (par distinto). */
export const signWithOtherKey = (options: SignOptions = {}): string => sign({ ...options, key: other.privateKey });

export const bearerOf = (token: string): string => `Bearer ${token}`;
