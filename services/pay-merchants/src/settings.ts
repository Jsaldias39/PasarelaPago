import { createPublicKey } from 'node:crypto';
import { payModeOf, type PayMode } from './config';

/**
 * Parámetros propios de pay-merchants (aparte de `ServiceConfig`, que es el de la plantilla).
 * Los valores por defecto son SUPUESTOS operativos, no reglas de negocio: están registrados en
 * docs/trabajo/ola-1/P5/DECISIONES-TOMADAS.md para confirmarlos.
 */
export interface OperatorTokenSettings {
  /** Clave pública RSA (PEM) del servicio de identidad: con ella se verifican las credenciales de operador (RS256). */
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface Settings {
  /** Despliegue (D-26). La credencial de operador solo vale en el modo para el que se emitió. */
  readonly payMode: PayMode;
  /** Verificador de operadores. Sin él, el back-office responde 401 (falla cerrado). En `live` es obligatorio. */
  readonly operator?: OperatorTokenSettings;
  /** Backend del almacén de objetos de KYC. Solo existe `fs`, un doble [DEV]: bajo `live` el servicio no arranca. */
  readonly kycStoreBackend: 'fs';
  /** Tamaño máximo de un documento KYC, en bytes. */
  readonly kycMaxBytes: number;
  /** Carpeta del almacén de objetos de desarrollo (`FsObjectStore`). */
  readonly kycStoreDir: string;
  /** Cuánto sigue válida una clave después de rotarla. */
  readonly apiKeyRotationGraceSeconds: number;
  /** Claves sin revocar por comercio. */
  readonly apiKeyMaxActive: number;
  /** Desactiva el barrido periódico de claves rotadas (pruebas). */
  readonly backgroundJobsEnabled: boolean;
}

export const SETTINGS = Symbol('SETTINGS');

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser un entero positivo: ${raw}`);
  return value;
}

/** Credencial de operador: las tres variables juntas o ninguna; bajo `live`, siempre. NUNCA hay una clave por defecto. */
export function operatorSettings(env: NodeJS.ProcessEnv, payMode: PayMode): OperatorTokenSettings | undefined {
  const names = ['OPERATOR_TOKEN_PUBLIC_KEY', 'OPERATOR_TOKEN_ISSUER', 'OPERATOR_TOKEN_AUDIENCE'] as const;
  const present = names.filter((n) => env[n] !== undefined && env[n] !== '');
  if (present.length === 0) {
    if (payMode === 'live') throw new Error('PAY_MODE=live exige la credencial de operador: OPERATOR_TOKEN_PUBLIC_KEY, OPERATOR_TOKEN_ISSUER y OPERATOR_TOKEN_AUDIENCE');
    return undefined;
  }
  for (const name of names) if (!present.includes(name)) throw new Error(`Falta la variable de entorno ${name} (la credencial de operador se configura completa)`);
  const publicKeyPem = (env.OPERATOR_TOKEN_PUBLIC_KEY as string).replace(/\\n/g, '\n');
  try {
    // Falla al arrancar si la clave no es una clave pública RSA válida, en vez de negar a todos en silencio.
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('no es RSA');
  } catch {
    throw new Error('OPERATOR_TOKEN_PUBLIC_KEY no es una clave pública RSA válida (PEM)');
  }
  return { publicKeyPem, issuer: env.OPERATOR_TOKEN_ISSUER as string, audience: env.OPERATOR_TOKEN_AUDIENCE as string };
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const payMode = payModeOf(env);
  const backend = env.KYC_STORE_BACKEND || 'fs';
  if (backend !== 'fs') throw new Error(`KYC_STORE_BACKEND no soportado: ${backend} (solo existe fs)`);
  // Bajo `live` no se arranca con ningún doble ni con interruptores de prueba; se listan TODOS los problemas de una vez.
  if (payMode === 'live') {
    const problems: string[] = [];
    if (backend === 'fs') problems.push('KYC_STORE_BACKEND=fs es un doble [DEV] (falta el almacén de objetos de producción)');
    if (env.DISABLE_BACKGROUND_JOBS === '1') problems.push('DISABLE_BACKGROUND_JOBS=1 es un interruptor de pruebas');
    if (problems.length > 0) throw new Error(`PAY_MODE=live no arranca con dobles ni interruptores de prueba: ${problems.join('; ')}`);
  }
  const operator = operatorSettings(env, payMode);
  return {
    payMode,
    ...(operator && { operator }),
    kycStoreBackend: 'fs',
    kycMaxBytes: positiveInt(env, 'KYC_MAX_BYTES', 10 * 1024 * 1024),
    kycStoreDir: env.KYC_STORE_DIR || './.data/kyc',
    apiKeyRotationGraceSeconds: positiveInt(env, 'API_KEY_ROTATION_GRACE_SECONDS', 24 * 60 * 60),
    apiKeyMaxActive: positiveInt(env, 'API_KEY_MAX_ACTIVE', 20),
    backgroundJobsEnabled: env.DISABLE_BACKGROUND_JOBS !== '1',
  };
}
