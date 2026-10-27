import { z } from 'zod';
import { ProblemError } from '@pay/problem';

const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

export const merchantId = z.string().regex(/^mc_[a-z0-9]{10,40}$/);
const amount = z.number().int().min(1).max(MAX_AMOUNT);
const currency = z.literal('BOB');
const rail = z.enum(['bank_transfer', 'acquirer_settlement']);
const note = z.string().min(1).max(500);
const timestamp = z.iso.datetime();

export const payoutCreate = z.strictObject({
  merchant_id: merchantId,
  amount_minor: amount,
  currency,
  rail,
  reason: z.enum(['weekly_cut', 'mandate_obligation', 'mandate_commission', 'manual']).default('manual'),
  batch_id: z.string().regex(/^sb_[a-z0-9]{10,40}$/).optional(),
});

export const batchCreate = z.strictObject({
  cutoff_date: z.iso.date(),
  release_days: z.number().int().min(0).max(60).optional(),
});

export const runCreate = z.strictObject({
  connector: z.enum(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']),
  period_from: timestamp,
  period_to: timestamp,
});

export const exceptionResolve = z.strictObject({
  resolution: z.enum(['request_adjustment', 'dismiss']),
  note,
});

/** Cobro (declarado en `internal-settlement-v1.yaml` desde la ola 2): a un comercio que se netea contra su saldo. */
export const chargeCreate = z
  .strictObject({
    merchant_id: merchantId,
    kind: z.enum(['provider_commission', 'chargeback_debt']),
    reference: z.string().regex(/^[A-Za-z0-9_.:-]{3,80}$/),
    amount_minor: amount,
    currency,
    /** Conector al que se le devuelve el contracargo: obligatorio solo para `chargeback_debt`. */
    connector: z.string().regex(/^[a-z_]{3,30}$/).optional(),
  })
  .refine((c) => (c.kind === 'chargeback_debt') === (c.connector !== undefined), { path: ['connector'], message: 'connector_required_only_for_chargeback' });

export const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().max(200).optional(),
});

export const payoutListQuery = listQuery.extend({
  merchant_id: merchantId.optional(),
  status: z.enum(['pending', 'in_transit', 'paid', 'failed']).optional(),
});

/** La consulta pública (`public-v1.yaml`) solo admite `limit` y `starting_after`: el comercio sale de `X-Merchant-Id`, no de un parámetro. */
export const publicPayoutListQuery = listQuery;

export const exceptionListQuery = listQuery.extend({ status: z.enum(['open', 'resolved', 'dismissed']).optional() });

export const exportQuery = z.strictObject({ period_from: timestamp, period_to: timestamp, format: z.enum(['json', 'csv']).default('json') });

export const payoutId = z.string().regex(/^po_[a-z0-9]{10,40}$/);
export const runId = z.string().regex(/^rr_[a-z0-9]{10,40}$/);
export const exceptionId = z.string().regex(/^rx_[a-z0-9]{10,40}$/);
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

export function fieldError(field: string, code: string): ProblemError {
  return new ProblemError('validation_failed', { errors: [{ field, code }] });
}

/** Exige `Idempotency-Key` (400). */
export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = idempotencyKey.safeParse(value);
  if (!parsed.success) throw new ProblemError('idempotency_key_required');
  return parsed.data;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
}

export function decodeCursor(value: string): { at: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof parsed.at === 'string' && typeof parsed.id === 'string' && !Number.isNaN(Date.parse(parsed.at))) return { at: parsed.at, id: parsed.id };
  } catch {
    /* cae al error de abajo */
  }
  throw fieldError('starting_after', 'invalid_cursor');
}
