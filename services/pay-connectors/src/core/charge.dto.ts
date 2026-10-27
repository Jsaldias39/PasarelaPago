import { ProblemError, type FieldError } from '@pay/problem';
import type { ConnectorCode, Method } from '../domain/connector';

const MERCHANT = /^mc_[a-z0-9]{10,40}$/;
const INTENT = /^pi_[a-z0-9]{10,40}$/;
const CARD_TOKEN = /^tok_[a-z0-9]{10,60}$/;
const ALLOWED = new Set(['payment_intent_id', 'merchant_id', 'amount_minor', 'currency', 'method', 'preferred_connector', 'card_token', 'expires_at', 'description']);
/** El nombre de un campo desconocido lo escribe el cliente: solo se repite si parece un nombre de campo (no un número ni un nombre propio). */
const fieldName = (key: string): string => (/^[a-z][a-z0-9_]{0,39}$/.test(key) ? key : '?');
const METHODS = new Set<string>(['qr', 'card', 'bank_transfer']);
const CONNECTORS = new Set<string>(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']);

export interface CreateCharge {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly method: Method;
  readonly preferred?: ConnectorCode;
  readonly cardToken?: string;
  readonly expiresAt: Date;
  readonly description?: string;
}

/** Valida `POST /charges`. Acumula los errores por campo y rechaza campos no declarados (regla 96.2). */
export function parseCreateCharge(body: unknown, now: Date): CreateCharge {
  const errors: FieldError[] = [];
  const bad = (field: string, code: string) => errors.push({ field, code });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError('validation_failed', { errors: [{ field: '/', code: 'not_an_object' }] });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!ALLOWED.has(key)) bad(fieldName(key), 'unknown_field');

  if (typeof b.payment_intent_id !== 'string' || !INTENT.test(b.payment_intent_id)) bad('payment_intent_id', 'invalid');
  if (typeof b.merchant_id !== 'string' || !MERCHANT.test(b.merchant_id)) bad('merchant_id', 'invalid');
  let amountMinor = 0n;
  if (typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor < 1) bad('amount_minor', 'invalid');
  else amountMinor = BigInt(b.amount_minor);
  if (b.currency !== 'BOB') bad('currency', 'unsupported');
  if (typeof b.method !== 'string' || !METHODS.has(b.method)) bad('method', 'invalid');
  if (b.preferred_connector !== undefined && (typeof b.preferred_connector !== 'string' || !CONNECTORS.has(b.preferred_connector))) bad('preferred_connector', 'invalid');
  if (b.card_token !== undefined) {
    if (typeof b.card_token !== 'string' || !CARD_TOKEN.test(b.card_token)) bad('card_token', 'invalid');
    else if (b.method !== 'card') bad('card_token', 'not_allowed_for_method');
  }
  const when = typeof b.expires_at === 'string' ? new Date(b.expires_at) : null;
  if (!when || Number.isNaN(when.getTime())) bad('expires_at', 'invalid');
  else if (when.getTime() <= now.getTime()) bad('expires_at', 'in_the_past');
  if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 200)) bad('description', 'invalid');
  if (errors.length > 0) throw new ProblemError('validation_failed', { errors });

  return {
    paymentIntentId: b.payment_intent_id as string,
    merchantId: b.merchant_id as string,
    amountMinor,
    method: b.method as Method,
    ...(b.preferred_connector !== undefined && { preferred: b.preferred_connector as ConnectorCode }),
    ...(b.card_token !== undefined && { cardToken: b.card_token as string }),
    expiresAt: when as Date,
    ...(b.description !== undefined && { description: b.description as string }),
  };
}

/** Valida el cuerpo de `POST /charges/{id}/refunds`. */
export function parseCreateRefund(body: unknown): { amountMinor: bigint } {
  const errors: FieldError[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError('validation_failed', { errors: [{ field: '/', code: 'not_an_object' }] });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (key !== 'amount_minor' && key !== 'reason') errors.push({ field: fieldName(key), code: 'unknown_field' });
  if (typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor < 1) errors.push({ field: 'amount_minor', code: 'invalid' });
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) errors.push({ field: 'reason', code: 'invalid' });
  if (errors.length > 0) throw new ProblemError('validation_failed', { errors });
  return { amountMinor: BigInt(b.amount_minor as number) };
}
