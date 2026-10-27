import { ProblemError, type FieldError } from '@pay/problem';
import { CARD_TOKEN_PATTERN, containsPan } from '../domain/pan';
import type { PaymentMethod } from '../domain/quote';

const METHODS: readonly PaymentMethod[] = ['qr', 'card', 'bank_transfer', 'wallet'];
const REASONS = ['requested_by_customer', 'duplicate', 'fraudulent', 'other'] as const;
const METADATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

class Collector {
  readonly errors: FieldError[] = [];
  add(field: string, code: string): void {
    this.errors.push({ field, code });
  }
  /** Lista blanca de campos (mass assignment, regla 96.2.2): un campo desconocido se rechaza, no se ignora. */
  strict(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.add(path ? `${path}.${key}` : key, 'unknown_field');
  }
  done(): void {
    if (this.errors.length > 0) throw new ProblemError('validation_failed', { errors: this.errors });
  }
}

/** Rechaza texto libre que contenga un número de tarjeta, sin repetirlo en el error (el PAN solo existe en pay-vault). */
function noPan(c: Collector, field: string, text: string): void {
  if (containsPan(text)) c.add(field, 'contains_card_number');
}

function metadata(c: Collector, value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) {
    c.add(path, 'invalid_type');
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > 20) c.add(path, 'too_many_properties');
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!METADATA_KEY.test(key)) c.add(`${path}.${key.slice(0, 40)}`, 'invalid_key');
    else if (typeof v !== 'string' || v.length > 200) c.add(`${path}.${key}`, 'invalid_value');
    else {
      noPan(c, `${path}.${key}`, v);
      out[key] = v;
    }
  }
  return out;
}

export interface CreateIntentInput {
  readonly amountMinor: number;
  readonly method: PaymentMethod;
  readonly cardToken?: string;
  readonly walletAuthorization?: string;
  readonly description?: string;
  /** Nombre del pagador, solo para cribarlo en pay-risk (D-29/D-33). Dato personal: nunca se devuelve ni se publica. */
  readonly payerName?: string;
  readonly expiresInSeconds: number;
  readonly metadata: Record<string, string>;
}

export function parseCreateIntent(body: unknown): CreateIntentInput {
  const c = new Collector();
  if (!isObject(body)) throw new ProblemError('validation_failed', { errors: [{ field: '', code: 'invalid_type' }] });
  c.strict(body, ['amount_minor', 'currency', 'payment_method', 'description', 'payer_name', 'expires_in_seconds', 'metadata'], '');

  const amount = body.amount_minor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) c.add('amount_minor', 'invalid_amount');
  if (body.currency !== 'BOB') c.add('currency', 'unsupported_currency');

  const pm = body.payment_method;
  let method: PaymentMethod = 'qr';
  let cardToken: string | undefined;
  let walletAuthorization: string | undefined;
  if (!isObject(pm)) c.add('payment_method', 'required');
  else {
    c.strict(pm, ['type', 'card_token', 'wallet_authorization'], 'payment_method');
    if (typeof pm.type !== 'string' || !METHODS.includes(pm.type as PaymentMethod)) c.add('payment_method.type', 'invalid_value');
    else method = pm.type as PaymentMethod;
    if (pm.card_token !== undefined) {
      if (method !== 'card') c.add('payment_method.card_token', 'not_allowed_for_method');
      else if (typeof pm.card_token !== 'string' || !CARD_TOKEN_PATTERN.test(pm.card_token)) c.add('payment_method.card_token', 'invalid_token'); // nunca se repite el valor
      else cardToken = pm.card_token;
    } else if (method === 'card') c.add('payment_method.card_token', 'required');
    if (pm.wallet_authorization !== undefined) {
      if (method !== 'wallet') c.add('payment_method.wallet_authorization', 'not_allowed_for_method');
      else if (typeof pm.wallet_authorization !== 'string' || pm.wallet_authorization.length < 1 || pm.wallet_authorization.length > 500) c.add('payment_method.wallet_authorization', 'invalid_token');
      else {
        walletAuthorization = pm.wallet_authorization;
        noPan(c, 'payment_method.wallet_authorization', walletAuthorization);
      }
    } else if (method === 'wallet') c.add('payment_method.wallet_authorization', 'required');
  }

  let description: string | undefined;
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 200) c.add('description', 'invalid_value');
    else {
      description = body.description;
      noPan(c, 'description', description);
    }
  }
  let payerName: string | undefined;
  if (body.payer_name !== undefined) {
    // Contrato: 1..200. Un nombre en blanco no cribaría nada: se rechaza en vez de mandar «   » a pay-risk. Nunca se repite el valor en el error.
    if (typeof body.payer_name !== 'string' || body.payer_name.length < 1 || body.payer_name.length > 200 || body.payer_name.trim() === '') c.add('payer_name', 'invalid_value');
    else {
      payerName = body.payer_name.trim();
      noPan(c, 'payer_name', payerName);
    }
  }
  let expiresInSeconds = 3600;
  if (body.expires_in_seconds !== undefined) {
    const e = body.expires_in_seconds;
    if (typeof e !== 'number' || !Number.isInteger(e) || e < 60 || e > 86400) c.add('expires_in_seconds', 'out_of_range');
    else expiresInSeconds = e;
  }
  const meta = metadata(c, body.metadata, 'metadata');
  c.done();
  return {
    amountMinor: amount as number,
    method,
    ...(cardToken ? { cardToken } : {}),
    ...(walletAuthorization ? { walletAuthorization } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(payerName ? { payerName } : {}),
    expiresInSeconds,
    metadata: meta,
  };
}

export interface CreateRefundInput {
  readonly amountMinor: number;
  readonly reason?: (typeof REASONS)[number];
  readonly metadata: Record<string, string>;
}

export function parseCreateRefund(body: unknown): CreateRefundInput {
  const c = new Collector();
  if (!isObject(body)) throw new ProblemError('validation_failed', { errors: [{ field: '', code: 'invalid_type' }] });
  c.strict(body, ['amount_minor', 'reason', 'metadata'], '');
  const amount = body.amount_minor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) c.add('amount_minor', 'invalid_amount');
  let reason: (typeof REASONS)[number] | undefined;
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string' || !(REASONS as readonly string[]).includes(body.reason)) c.add('reason', 'invalid_value');
    else reason = body.reason as (typeof REASONS)[number];
  }
  const meta = metadata(c, body.metadata, 'metadata');
  c.done();
  return { amountMinor: amount as number, ...(reason ? { reason } : {}), metadata: meta };
}

export interface ListInput {
  readonly limit: number;
  readonly startingAfter?: string;
  readonly status?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

const STATUSES = ['requires_action', 'processing', 'succeeded', 'failed', 'canceled', 'expired'];

export function parseList(query: Record<string, unknown>): ListInput {
  const c = new Collector();
  let limit = 20;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) c.add('limit', 'out_of_range');
    else limit = n;
  }
  const str = (name: string): string | undefined => (typeof query[name] === 'string' ? (query[name] as string) : undefined);
  const startingAfter = str('starting_after');
  if (startingAfter !== undefined && startingAfter.length > 200) c.add('starting_after', 'invalid_cursor');
  const status = str('status');
  if (status !== undefined && !STATUSES.includes(status)) c.add('status', 'invalid_value');
  const date = (name: string): Date | undefined => {
    const v = str(name);
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) c.add(name, 'invalid_timestamp');
    return d;
  };
  const createdFrom = date('created_from');
  const createdTo = date('created_to');
  c.done();
  return { limit, ...(startingAfter ? { startingAfter } : {}), ...(status ? { status } : {}), ...(createdFrom ? { createdFrom } : {}), ...(createdTo ? { createdTo } : {}) };
}

export interface InternalIntentInput {
  readonly source: { kind: 'mandate'; id: string; period: string };
  readonly kind: 'obligation' | 'commission';
  readonly payerMerchantId: string;
  readonly beneficiaryMerchantId: string;
  readonly amountMinor: number;
  readonly description?: string;
}

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;

export function parseInternalIntent(body: unknown): InternalIntentInput {
  const c = new Collector();
  if (!isObject(body)) throw new ProblemError('validation_failed', { errors: [{ field: '', code: 'invalid_type' }] });
  c.strict(body, ['source', 'kind', 'payer_merchant_id', 'beneficiary_merchant_id', 'amount_minor', 'currency', 'payment_method', 'description'], '');
  const source = body.source;
  let src: InternalIntentInput['source'] = { kind: 'mandate', id: '', period: '' };
  if (!isObject(source)) c.add('source', 'required');
  else {
    c.strict(source, ['kind', 'id', 'period'], 'source');
    if (source.kind !== 'mandate') c.add('source.kind', 'invalid_value');
    if (typeof source.id !== 'string' || !/^md_[a-z0-9]{10,40}$/.test(source.id)) c.add('source.id', 'invalid_value');
    if (typeof source.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(source.period)) c.add('source.period', 'invalid_value');
    src = { kind: 'mandate', id: String(source.id), period: String(source.period) };
  }
  if (body.kind !== 'obligation' && body.kind !== 'commission') c.add('kind', 'invalid_value');
  for (const f of ['payer_merchant_id', 'beneficiary_merchant_id'] as const) if (typeof body[f] !== 'string' || !MERCHANT_ID.test(body[f] as string)) c.add(f, 'invalid_value');
  const amount = body.amount_minor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) c.add('amount_minor', 'invalid_amount');
  if (body.currency !== 'BOB') c.add('currency', 'unsupported_currency');
  const pm = body.payment_method;
  if (!isObject(pm) || pm.type !== 'wallet') c.add('payment_method.type', 'invalid_value');
  else c.strict(pm, ['type'], 'payment_method');
  let description: string | undefined;
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 200) c.add('description', 'invalid_value');
    else {
      description = body.description;
      noPan(c, 'description', description);
    }
  }
  c.done();
  return { source: src, kind: body.kind as 'obligation' | 'commission', payerMerchantId: body.payer_merchant_id as string, beneficiaryMerchantId: body.beneficiary_merchant_id as string, amountMinor: amount as number, ...(description !== undefined ? { description } : {}) };
}
