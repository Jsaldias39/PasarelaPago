import { z } from 'zod';
import { ProblemError } from '@pay/problem';
import { LEG_CODES } from './tb-engine';
import { parseAccount } from './accounts';

/** Tope seguro de JSON para un importe en centavos. */
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

const businessRef = z
  .string()
  .max(100)
  .regex(/^[a-z0-9_]{2,10}_[a-z0-9]{10,40}:[a-z_]{3,30}$/, 'business_ref inválido');
const account = z.string().refine((value) => parseAccount(value) !== null, { message: 'cuenta fuera del plan de cuentas' });
const amount = z.number().int().min(1).max(MAX_AMOUNT);
const attempt = z.number().int().min(1).max(1000);
const currency = z.literal('BOB');

const leg = z.strictObject({
  debit_account: account,
  credit_account: account,
  amount_minor: amount,
  code: z.enum(LEG_CODES).optional(),
});

export const transactionCreate = z.strictObject({
  business_ref: businessRef,
  attempt,
  currency,
  legs: z.array(leg).min(1).max(100),
});

export const holdCreate = z.strictObject({
  business_ref: businessRef,
  attempt,
  debit_account: account,
  credit_account: account,
  amount_minor: amount,
  currency,
  expires_in_seconds: z.number().int().min(1).max(2_592_000),
});

export const holdPostBody = z.strictObject({ amount_minor: amount.optional() }).optional();

export const accountQuery = z.strictObject({ account });

export const statementQuery = z.strictObject({
  account,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const holdId = z.string().regex(/^hd_[a-z0-9]{10,40}$/);
export const merchantId = z.string().regex(/^mc_[a-z0-9]{10,40}$/);
export const idempotencyKey = z.string().min(8).max(255);

/** Valida con zod y, si falla, lanza un 422 `validation_failed` con un error por campo (sin devolver los valores). */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProblemError('validation_failed', {
    errors: result.error.issues.slice(0, 20).map((issue) => ({
      field: issue.path.join('.') || '(cuerpo)',
      code: issue.code.replace(/[^a-z0-9_]/g, '_').toLowerCase(),
    })),
  });
}

/** Exige `Idempotency-Key` (400). En el ledger la idempotencia real es (business_ref, attempt); la cabecera se exige por uniformidad. */
export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = idempotencyKey.safeParse(value);
  if (!parsed.success) throw new ProblemError('idempotency_key_required');
  return parsed.data;
}
