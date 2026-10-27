import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ProblemError } from '@pay/problem';

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

/** `/channels/0/percent` → `channels[0].percent`. */
function fieldOf(error: ErrorObject): string {
  let path = error.instancePath.replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.').replace(/^\./, '');
  const extra = (error.params as { missingProperty?: string; additionalProperty?: string }).missingProperty ?? (error.params as { additionalProperty?: string }).additionalProperty;
  if (extra) path = path ? `${path}.${extra}` : extra;
  return path || 'body';
}

/**
 * Compila un esquema una vez. Los errores devuelven el CAMPO y el tipo de falla, nunca el valor recibido
 * (podría ser un dato personal; regla 90.2).
 */
export function compile<T>(schema: object): (body: unknown) => T {
  const validate: ValidateFunction = ajv.compile(schema);
  return (body: unknown): T => {
    if (validate(body)) return body as T;
    throw new ProblemError('validation_failed', { errors: (validate.errors ?? []).map((e) => ({ field: fieldOf(e), code: e.keyword })) });
  };
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;

/** `Idempotency-Key` obligatoria en toda mutación pública (REQ-P1-2). */
export function requireIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) throw new ProblemError('idempotency_key_required');
  if (!IDEMPOTENCY_KEY.test(key)) throw new ProblemError('validation_failed', { errors: [{ field: 'Idempotency-Key', code: 'format' }] });
  return key;
}

export const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
