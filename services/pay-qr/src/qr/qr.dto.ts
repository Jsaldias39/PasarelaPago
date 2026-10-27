import { ProblemError, type FieldError } from '@pay/problem';
import type { CreateQr } from './qr.service';

const MERCHANT = /^mc_[a-z0-9]{10,40}$/;
const INTENT = /^pi_[a-z0-9]{10,40}$/;
const ALLOWED = new Set(['kind', 'merchant_id', 'merchant_name', 'merchant_city', 'mcc', 'currency', 'amount_minor', 'payment_intent_id', 'expires_at']);

/** Valida el cuerpo de `POST /qr`. Acumula todos los errores por campo y rechaza campos no declarados. */
export function parseCreateQr(body: unknown): CreateQr {
  const errors: FieldError[] = [];
  const bad = (field: string, code: string) => errors.push({ field, code });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError('validation_failed', { errors: [{ field: '/', code: 'not_an_object' }] });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!ALLOWED.has(key)) bad(key, 'unknown_field');

  const kind = b.kind;
  if (kind !== 'static' && kind !== 'dynamic') bad('kind', 'invalid');
  if (typeof b.merchant_id !== 'string' || !MERCHANT.test(b.merchant_id)) bad('merchant_id', 'invalid');
  for (const [field, max] of [['merchant_name', 60], ['merchant_city', 40]] as const) {
    const v = b[field];
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) bad(field, 'invalid');
  }
  if (b.mcc !== undefined && (typeof b.mcc !== 'string' || !/^\d{4}$/.test(b.mcc))) bad('mcc', 'invalid');
  if (b.currency !== 'BOB') bad('currency', 'unsupported');

  let amountMinor: bigint | undefined;
  let expiresAt: Date | undefined;
  if (kind === 'dynamic') {
    if (typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor < 1) bad('amount_minor', 'invalid');
    else amountMinor = BigInt(b.amount_minor);
    if (typeof b.payment_intent_id !== 'string' || !INTENT.test(b.payment_intent_id)) bad('payment_intent_id', 'invalid');
    const when = typeof b.expires_at === 'string' ? new Date(b.expires_at) : null;
    if (!when || Number.isNaN(when.getTime())) bad('expires_at', 'invalid');
    else expiresAt = when;
  } else if (kind === 'static') {
    for (const field of ['amount_minor', 'payment_intent_id', 'expires_at']) if (b[field] !== undefined) bad(field, 'not_allowed_for_static');
  }
  if (errors.length > 0) throw new ProblemError('validation_failed', { errors });

  return {
    kind: kind as CreateQr['kind'],
    merchantId: b.merchant_id as string,
    merchantName: b.merchant_name as string,
    merchantCity: b.merchant_city as string,
    mcc: b.mcc as string | undefined,
    amountMinor,
    paymentIntentId: b.payment_intent_id as string | undefined,
    expiresAt,
  };
}
