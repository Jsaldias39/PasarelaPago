import { Inject, Injectable } from '@nestjs/common';
import { ProblemError, type FieldError } from '@pay/problem';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { ConnectorTimeoutError, ConnectorUnavailableError, type ConnectorCode, type StatementLine } from '../domain/connector';
import type { ConnectorRegistry } from '../domain/registry';
import { toCamt053, toCsv } from '../domain/statement-formats';
import { recordAndApply } from './apply';
import { inTransaction } from './db';
import type { PayMode } from './pay-mode';
import { REGISTRY, CLOCK, type Clock } from './tokens';

const CODES = new Set<string>(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']);
const MAX_RANGE_MS = 92 * 24 * 3600 * 1000;

export type StatementFormat = 'json' | 'xml' | 'csv';

export function negotiate(accept: string | undefined): StatementFormat {
  const value = (accept ?? '').toLowerCase();
  if (value.includes('application/xml') || value.includes('text/xml')) return 'xml';
  if (value.includes('text/csv')) return 'csv';
  return 'json';
}

type MatchedLine = StatementLine & { chargeId: string | null; paymentIntentId: string | null; merchantId: string | null };

export interface ReconcileSummary {
  readonly lines: number;
  readonly matched: number;
  readonly captured: number;
  readonly exceptions: number;
}

@Injectable()
export class StatementsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
  ) {}

  /** Empareja cada línea con un cobro: por `ch_…` directo o, si es una referencia de transferencia, por su tabla. */
  private async match(connector: ConnectorCode, lines: readonly StatementLine[], mode?: PayMode): Promise<MatchedLine[]> {
    const refs = [...new Set(lines.map((l) => l.ourReference).filter((r): r is string => r !== null))];
    const byRef = new Map<string, string>();
    if (refs.length > 0) {
      // Con modo en la petición, solo se emparejan cobros de ESE modo; la conciliación interna (sin petición) usa el modo del registro del cobro.
      const direct = await this.pool.query('SELECT id FROM connector_charges WHERE id = ANY($1) AND connector = $2 AND ($3::text IS NULL OR pay_mode = $3)', [refs, connector, mode ?? null]);
      for (const r of direct.rows) byRef.set(r.id as string, r.id as string);
      const transfers = await this.pool.query(
        'SELECT r.reference, r.charge_id FROM bank_transfer_references r JOIN connector_charges c ON c.id = r.charge_id WHERE r.reference = ANY($1) AND ($2::text IS NULL OR c.pay_mode = $2)',
        [refs, mode ?? null],
      );
      for (const r of transfers.rows) byRef.set(r.reference as string, r.charge_id as string);
    }
    // El intento de pago y el comercio salen de NUESTRO registro de cobros (un banco no conoce nuestros `pi_…` ni `mc_…`): `payment_intent_id` es la clave con la
    // que pay-settlement cruza con el ledger. Sin cobro emparejado ambos son nulos: nunca se infieren.
    const known = new Map<string, { paymentIntentId: string; merchantId: string }>();
    const chargeIds = [...new Set(byRef.values())];
    if (chargeIds.length > 0) {
      for (const r of (await this.pool.query('SELECT id, payment_intent_id, merchant_id FROM connector_charges WHERE id = ANY($1)', [chargeIds])).rows) known.set(r.id as string, { paymentIntentId: r.payment_intent_id as string, merchantId: r.merchant_id as string });
    }
    return lines.map((l) => {
      const chargeId = l.ourReference ? (byRef.get(l.ourReference) ?? null) : null;
      const charge = chargeId ? known.get(chargeId) : undefined;
      return { ...l, chargeId, paymentIntentId: charge?.paymentIntentId ?? null, merchantId: charge?.merchantId ?? null };
    });
  }

  // ───────────────────────── GET /statements ─────────────────────────

  async get(query: { connector?: string; from?: string; to?: string; limit?: string; startingAfter?: string }, format: StatementFormat, mode?: PayMode): Promise<{ contentType: string; body: unknown }> {
    const errors: FieldError[] = [];
    if (!query.connector || !CODES.has(query.connector)) errors.push({ field: 'connector', code: 'invalid' });
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (!from || Number.isNaN(from.getTime())) errors.push({ field: 'from', code: 'invalid' });
    if (!to || Number.isNaN(to.getTime())) errors.push({ field: 'to', code: 'invalid' });
    if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      if (to < from) errors.push({ field: 'to', code: 'before_from' });
      else if (to.getTime() - from.getTime() > MAX_RANGE_MS) errors.push({ field: 'to', code: 'range_too_large' });
    }
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.push({ field: 'limit', code: 'invalid' });
    if (query.startingAfter !== undefined && (query.startingAfter.length === 0 || query.startingAfter.length > 200)) errors.push({ field: 'starting_after', code: 'invalid' });
    if (errors.length > 0) throw new ProblemError('validation_failed', { errors });

    const code = query.connector as ConnectorCode;
    const connector = this.registry.get(code);
    if (!connector) throw new ProblemError('validation_failed', { errors: [{ field: 'connector', code: 'not_available' }] });

    let raw: readonly StatementLine[];
    try {
      raw = await connector.fetchStatement({ from: from as Date, to: to as Date });
    } catch (error) {
      if (error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError) throw new ProblemError('connector_unavailable');
      throw error;
    }
    // Más nueva primero; el desempate por referencia hace estable la paginación.
    const sorted = [...raw].sort((a, b) => (b.bookedAt?.getTime() ?? 0) - (a.bookedAt?.getTime() ?? 0) || (a.providerReference < b.providerReference ? 1 : -1));
    let start = 0;
    if (query.startingAfter !== undefined) {
      const cursor = decodeCursor(query.startingAfter);
      const at = sorted.findIndex((l) => l.providerReference === cursor);
      if (at < 0) throw new ProblemError('validation_failed', { errors: [{ field: 'starting_after', code: 'unknown_cursor' }] });
      start = at + 1;
    }
    const page = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    const matched = await this.match(code, page, mode);
    // La glosa del banco no sale de este servicio: puede traer nombres o cuentas. Se reabre cuando el formato del banco esté revisado (PROPUESTAS.md).
    const safe = matched.map((l) => ({ ...l, description: null }));

    if (format === 'xml') {
      return { contentType: 'application/xml', body: toCamt053(safe, { connector: code, accountId: 'COLLECTION-ACCOUNT', from: from as Date, to: to as Date, generatedAt: this.clock.now() }) };
    }
    if (format === 'csv') return { contentType: 'text/csv', body: toCsv(safe) };
    return {
      contentType: 'application/json',
      body: {
        object: 'list',
        has_more: hasMore,
        next_cursor: hasMore && page.length > 0 ? encodeCursor((page[page.length - 1] as StatementLine).providerReference) : null,
        data: safe.map((l) => ({
          provider_reference: l.providerReference,
          our_reference: l.ourReference,
          charge_id: l.chargeId,
          payment_intent_id: l.paymentIntentId,
          merchant_id: l.merchantId,
          direction: l.direction,
          amount_minor: Number(l.amountMinor),
          currency: l.currency,
          value_date: l.valueDate,
          ...(l.bookedAt && { booked_at: l.bookedAt.toISOString() }),
          description: null,
        })),
      },
    };
  }

  // ───────────────────────── Conciliación ─────────────────────────

  /**
   * Compara el extracto del conector con los cobros. Idempotente (una línea ya vista no vuelve a registrarse).
   * - `bank_transfer`: un crédito con la referencia y el importe exactos CAPTURA el cobro (el extracto es la única señal).
   * - Cualquier conector: línea sin cobro (`unmatched`), con otro importe (`amount_mismatch`) o sobre un cobro ya
   *   fallido/anulado/vencido (`late_credit`) queda en `statement_exceptions` para conciliación humana. Nunca se descarta.
   */
  async reconcile(code: ConnectorCode, range: { from: Date; to: Date }): Promise<ReconcileSummary> {
    const connector = this.registry.get(code);
    if (!connector) throw new ProblemError('validation_failed', { errors: [{ field: 'connector', code: 'not_available' }] });
    const lines = (await connector.fetchStatement(range)).filter((l) => l.direction === 'credit');
    const matched = await this.match(code, lines);
    const now = this.clock.now();
    let captured = 0;
    let exceptions = 0;
    let matchedCount = 0;

    const raise = async (line: MatchedLine, kind: 'unmatched' | 'amount_mismatch' | 'late_credit', expected: bigint | null): Promise<void> => {
      const inserted = await this.pool.query(
        `INSERT INTO statement_exceptions (connector, provider_reference, kind, charge_id, expected_minor, actual_minor, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (connector, provider_reference, kind) DO NOTHING RETURNING 1`,
        [code, line.providerReference, kind, line.chargeId, expected?.toString() ?? null, line.amountMinor.toString(), now],
      );
      if (inserted.rows.length > 0) exceptions += 1;
    };

    for (const line of matched) {
      if (!line.chargeId) {
        await raise(line, 'unmatched', null);
        continue;
      }
      matchedCount += 1;
      const outcome = await inTransaction(this.pool, async (client) => {
        const locked = await client.query('SELECT * FROM connector_charges WHERE id = $1 FOR UPDATE', [line.chargeId]);
        const charge = locked.rows[0] as { amount_minor: string; provider_status: string } | undefined;
        if (!charge) return { kind: 'unmatched' as const, expected: null };
        const expected = BigInt(charge.amount_minor);
        if (expected !== line.amountMinor) return { kind: 'amount_mismatch' as const, expected };
        if (charge.provider_status === 'captured') return { kind: 'ok' as const };
        if (charge.provider_status === 'pending' || charge.provider_status === 'authorized') {
          if (code !== 'bank_transfer') return { kind: 'ok' as const };
          const applied = await recordAndApply(client, code, { providerEventId: `stmt:${line.providerReference}`, chargeReference: line.chargeId as string, status: 'captured', occurredAt: line.bookedAt ?? new Date(`${line.valueDate}T00:00:00Z`), amountMinor: line.amountMinor }, 'status_inquiry', now);
          return { kind: applied.result === 'applied' ? ('captured' as const) : ('ok' as const) };
        }
        return { kind: 'late_credit' as const, expected };
      });
      if (outcome.kind === 'captured') captured += 1;
      else if (outcome.kind === 'amount_mismatch' || outcome.kind === 'late_credit' || outcome.kind === 'unmatched') await raise(line, outcome.kind, outcome.expected);
    }
    return { lines: lines.length, matched: matchedCount, captured, exceptions };
  }

  /** Concilia cada conector registrado sobre la ventana de los últimos días. Lo llama el temporizador. */
  async reconcileAll(): Promise<void> {
    const to = this.clock.now();
    const from = new Date(to.getTime() - this.config.reconcile.lookbackHours * 3600 * 1000);
    for (const connector of this.registry.list()) {
      try {
        await this.reconcile(connector.code, { from, to });
      } catch (error) {
        if (!(error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError)) throw error;
      }
    }
  }
}

const encodeCursor = (reference: string): string => Buffer.from(reference, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString('utf8');
