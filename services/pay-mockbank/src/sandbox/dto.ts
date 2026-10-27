import { ProblemError } from '@pay/problem';

const CHARGE_REF = /^ch_[a-z0-9]{10,40}$/;
const REFUND_REF = /^cr_[a-z0-9]{10,40}$/;
const MAX_AMOUNT = 100_000_000_000n; // Bs 1.000 millones en unidades menores: techo de cordura de un doble

export class Fields {
  private readonly errors: Array<{ field: string; code: string }> = [];
  constructor(readonly body: Record<string, unknown>) {}

  fail(field: string, code: string): void {
    this.errors.push({ field, code });
  }

  done(): void {
    if (this.errors.length > 0) throw new ProblemError('validation_failed', { errors: this.errors });
  }
}

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProblemError('validation_failed', { errors: [{ field: 'body', code: 'invalid' }] });
  return body as Record<string, unknown>;
}

/** Lista blanca de campos: uno no declarado se rechaza (no se ignora en silencio). */
function allow(f: Fields, allowed: readonly string[]): void {
  for (const key of Object.keys(f.body)) if (!allowed.includes(key)) f.fail(key, 'unknown_field');
}

export function amount(f: Fields, field: string, required = true): bigint | undefined {
  const value = f.body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || BigInt(value) > MAX_AMOUNT) {
    f.fail(field, 'out_of_range');
    return undefined;
  }
  return BigInt(value);
}

function reference(f: Fields, field: string, pattern: RegExp): string {
  const value = f.body[field];
  if (typeof value !== 'string' || !pattern.test(value)) {
    f.fail(field, 'invalid');
    return '';
  }
  return value;
}

function date(f: Fields, field: string): Date {
  const value = f.body[field];
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    f.fail(field, 'invalid');
    return new Date(0);
  }
  return parsed;
}

export interface CreateCharge {
  reference: string;
  amountMinor: bigint;
  method: 'qr' | 'card' | 'bank_transfer';
  expiresAt: Date;
}

export function parseCreateCharge(body: unknown): CreateCharge {
  const f = new Fields(object(body));
  allow(f, ['reference', 'amount_minor', 'currency', 'method', 'expires_at']);
  const ref = reference(f, 'reference', CHARGE_REF);
  const amountMinor = amount(f, 'amount_minor') ?? 0n;
  if (f.body.currency !== 'BOB') f.fail('currency', 'invalid');
  const method = f.body.method;
  if (method !== 'qr' && method !== 'card' && method !== 'bank_transfer') f.fail('method', 'invalid');
  const expiresAt = date(f, 'expires_at');
  f.done();
  return { reference: ref, amountMinor, method: method as CreateCharge['method'], expiresAt };
}

export function parseQr(body: unknown): string {
  const f = new Fields(object(body));
  allow(f, ['payload']);
  const payload = f.body.payload;
  if (typeof payload !== 'string' || !/^000201.*6304[0-9A-F]{4}$/.test(payload) || payload.length > 512) f.fail('payload', 'invalid');
  f.done();
  return payload as string;
}

export function parseCreateRefund(body: unknown): { reference: string; chargeReference: string; amountMinor: bigint } {
  const f = new Fields(object(body));
  allow(f, ['reference', 'charge_reference', 'amount_minor']);
  const ref = reference(f, 'reference', REFUND_REF);
  const chargeReference = reference(f, 'charge_reference', CHARGE_REF);
  const amountMinor = amount(f, 'amount_minor') ?? 0n;
  f.done();
  return { reference: ref, chargeReference, amountMinor };
}

export function parseCreateTransfer(body: unknown): { reference: string; amountMinor: bigint; destinationRef: string } {
  const f = new Fields(object(body));
  allow(f, ['reference', 'amount_minor', 'destination_ref']);
  const ref = f.body.reference;
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 200) f.fail('reference', 'invalid');
  const destination = f.body.destination_ref;
  // Referencia opaca de la cuenta de liquidación: nunca un número de cuenta (Q-22).
  if (typeof destination !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(destination)) f.fail('destination_ref', 'invalid');
  const amountMinor = amount(f, 'amount_minor') ?? 0n;
  f.done();
  return { reference: ref as string, amountMinor, destinationRef: destination as string };
}

/** `tok_…` de prueba. Un PAN (12 a 19 dígitos, con o sin separadores) se rechaza SIN repetirlo en ningún mensaje. */
const CARD_TOKEN = /^tok_[A-Za-z0-9]{8,64}$/;
const PAN_LIKE = /(?:\d[ -]?){12,19}/;

export function parseCardAuthorization(body: unknown): { reference: string; amountMinor: bigint } {
  const f = new Fields(object(body));
  allow(f, ['reference', 'amount_minor', 'card_token']);
  const ref = reference(f, 'reference', CHARGE_REF);
  const amountMinor = amount(f, 'amount_minor') ?? 0n;
  const token = f.body.card_token;
  if (typeof token !== 'string' || !CARD_TOKEN.test(token) || PAN_LIKE.test(token)) f.fail('card_token', 'invalid');
  f.done();
  return { reference: ref, amountMinor };
}

export function parseCapture(body: unknown): bigint | undefined {
  const f = new Fields(object(body ?? {}));
  allow(f, ['amount_minor']);
  const value = amount(f, 'amount_minor', false);
  f.done();
  return value;
}

export function parseRange(query: Record<string, unknown>): { from: Date; to: Date; format: 'json' | 'csv' | 'camt053' } {
  const f = new Fields(query);
  const from = date(f, 'from');
  const to = date(f, 'to');
  const format = query.format ?? 'json';
  if (format !== 'json' && format !== 'csv' && format !== 'camt053') f.fail('format', 'invalid');
  if (from.getTime() > to.getTime()) f.fail('from', 'after_to');
  f.done();
  return { from, to, format: format as 'json' | 'csv' | 'camt053' };
}

export function parseInject(body: unknown): { ourReference: string | null; direction: 'credit' | 'debit'; amountMinor: bigint; bookedAt: Date; description: string | null } {
  const f = new Fields(object(body));
  allow(f, ['our_reference', 'direction', 'amount_minor', 'booked_at', 'description']);
  const amountMinor = amount(f, 'amount_minor') ?? 0n;
  if (f.body.direction !== 'credit' && f.body.direction !== 'debit') f.fail('direction', 'invalid');
  const bookedAt = date(f, 'booked_at');
  const our = f.body.our_reference;
  if (our !== undefined && our !== null && (typeof our !== 'string' || our.length > 100)) f.fail('our_reference', 'invalid');
  const description = f.body.description;
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 200)) f.fail('description', 'invalid');
  f.done();
  return { ourReference: (our as string | undefined) ?? null, direction: f.body.direction as 'credit' | 'debit', amountMinor, bookedAt, description: (description as string | undefined) ?? null };
}

export function parsePay(body: unknown): string {
  const f = new Fields(object(body));
  allow(f, ['qr_payload']);
  const payload = f.body.qr_payload;
  if (typeof payload !== 'string' || payload.length < 20 || payload.length > 512) f.fail('qr_payload', 'invalid');
  f.done();
  return payload as string;
}
