/**
 * Parámetros propios de pay-merchants (aparte de `ServiceConfig`, que es el de la plantilla).
 * Los valores por defecto son SUPUESTOS operativos, no reglas de negocio: están registrados en
 * docs/trabajo/ola-1/P5/DECISIONES-TOMADAS.md para confirmarlos.
 */
export interface Settings {
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

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    kycMaxBytes: positiveInt(env, 'KYC_MAX_BYTES', 10 * 1024 * 1024),
    kycStoreDir: env.KYC_STORE_DIR || './.data/kyc',
    apiKeyRotationGraceSeconds: positiveInt(env, 'API_KEY_ROTATION_GRACE_SECONDS', 24 * 60 * 60),
    apiKeyMaxActive: positiveInt(env, 'API_KEY_MAX_ACTIVE', 20),
    backgroundJobsEnabled: env.DISABLE_BACKGROUND_JOBS !== '1',
  };
}
