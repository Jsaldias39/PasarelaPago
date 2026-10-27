import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdempotencyStore, hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { type ExceptionRow, EXCEPTION_COLUMNS, type RunRow, RUN_COLUMNS, exceptionDto, runDto } from './dto';
import { LedgerUnavailableError, StatementMalformedError, StatementUnavailableError } from './errors';
import { randomId } from './ids';
import type { PayMode } from './mode';
import { PayoutService } from './payout.service';
import { CONNECTORS_PORT, type ConnectorsPort, LEDGER_PORT, type LedgerPort, type OperatorIdentity } from './ports';
import { type PayoutFact, reconcile } from './reconcile';
import { decodeCursor, encodeCursor, exceptionId, exceptionListQuery, exceptionResolve, fieldError, parseOrThrow, runCreate, runId } from './schemas';
import { emitExceptionOpened } from './settlement-events';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement.config';
import { parseStatement } from './statement-parsers';
import { inTransaction } from './unit-of-work';

/** Una corrida cubre a lo sumo este lapso: pedir años de extracto de una vez no es una conciliación, es un volcado. */
const MAX_RUN_DAYS = 93;
const CHUNK = 5000;

export const ROLE_OPERATOR = 'settlement_operator';
export const ROLE_ADMIN = 'settlement_admin';

@Injectable()
export class ReconciliationService implements OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly idempotency: IdempotencyStore;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(CONNECTORS_PORT) private readonly connectors: ConnectorsPort,
    @Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig,
    private readonly payouts: PayoutService,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.idle();
  }

  /** Espera a las corridas en curso (las pruebas y el cierre ordenado). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** `POST /reconciliation_runs` → 202. La corrida sigue en segundo plano; se consulta por su id. */
  createRun(rawBody: unknown, caller: string, mode: PayMode, idempotencyKey: string) {
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/reconciliation_runs', body: rawBody }) }, async () => {
      const input = parseOrThrow(runCreate, rawBody);
      const from = new Date(input.period_from);
      const to = new Date(input.period_to);
      if (from >= to) throw fieldError('period_to', 'must_be_after_period_from');
      if (to.getTime() - from.getTime() > MAX_RUN_DAYS * 86_400_000) throw fieldError('period_to', 'period_too_long');
      const id = randomId('rr');
      const inserted = await this.pool.query<RunRow>(
        `INSERT INTO settlement_reconciliation_runs (id, connector, period_from, period_to, source, status, requested_by, created_at, mode)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8) RETURNING ${RUN_COLUMNS}`,
        [id, input.connector, from, to, this.config.statementFormats[input.connector] === 'camt053' ? 'camt053' : this.config.statementFormats[input.connector] === 'csv' ? 'csv' : 'api', caller, new Date(), mode],
      );
      this.start(id);
      return { status: 202, body: runDto(inserted.rows[0]) };
    });
  }

  private start(id: string): void {
    const job = this.execute(id)
      .catch((error: Error) => this.logger.error({ run: id, err: error.name }, 'La corrida de conciliación terminó con error inesperado'))
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
  }

  /** `mode` solo lo pasa quien atiende una petición: una corrida del otro modo no existe para ella (404). El proceso interno lee sin modo. */
  async getRun(rawId: string, mode?: PayMode): Promise<RunRow> {
    const id = runId.safeParse(rawId);
    if (!id.success) throw new ProblemError('resource_not_found');
    const found = await this.pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM settlement_reconciliation_runs WHERE id = $1 AND ($2::text IS NULL OR mode = $2)`, [id.data, mode ?? null]);
    if (!found.rows[0]) throw new ProblemError('resource_not_found');
    return found.rows[0];
  }

  /** Retoma las corridas que quedaron en `running` (el proceso murió a mitad). Volver a correr una es seguro: nada se asienta hasta el final. */
  async resumeRunning(): Promise<number> {
    const stuck = await this.pool.query<{ id: string }>(`SELECT id FROM settlement_reconciliation_runs WHERE status = 'running' AND created_at <= $1 ORDER BY created_at LIMIT 20`, [new Date(Date.now() - this.config.stuckAfterMs)]);
    for (const { id } of stuck.rows) this.start(id);
    return stuck.rows.length;
  }

  private async fail(id: string, code: string): Promise<void> {
    await this.pool.query(`UPDATE settlement_reconciliation_runs SET status = 'failed', failure_code = $2, completed_at = $3 WHERE id = $1 AND status = 'running'`, [id, code, new Date()]);
  }

  /** Cuerpo de la corrida: obtiene el extracto, lo normaliza, lo cruza con el ledger y lo asienta todo junto (o nada). */
  async execute(id: string): Promise<void> {
    const run = await this.getRun(id);
    if (run.status !== 'running') return;
    const clearing = `connector:${run.connector}:clearing`;
    let result;
    try {
      const document = await this.connectors.getStatement({ connector: run.connector, from: run.period_from.toISOString(), to: run.period_to.toISOString(), format: this.config.statementFormats[run.connector] ?? 'json' });
      const statement = parseStatement(document);
      const ledger = await this.ledger.listStatement(run.mode, clearing, { from: run.period_from.toISOString(), to: run.period_to.toISOString() });
      const payouts = await this.payoutFacts(run.mode, statement.map((l) => l.our_reference));
      result = reconcile({ connector: run.connector, period: { from: run.period_from, to: run.period_to }, statement, ledger, payouts });
    } catch (error) {
      // Un extracto ilegible o un conector caído NO deja asientos a medias: la corrida falla entera y se reporta.
      if (error instanceof StatementMalformedError) return this.fail(id, 'statement_malformed');
      if (error instanceof StatementUnavailableError) return this.fail(id, 'connector_unavailable');
      if (error instanceof LedgerUnavailableError) return this.fail(id, 'ledger_unavailable');
      // Cualquier otro error en la lectura NO deja la corrida en `running`: el barrido la reintentaría para siempre. Falla y se reporta.
      this.logger.error({ run: id, err: error instanceof Error ? error.name : 'desconocido' }, 'La corrida de conciliación falló por un error inesperado');
      return this.fail(id, 'internal_error');
    }

    const now = new Date();
    const confirmed = await inTransaction(this.pool, async (client) => {
      const locked = await client.query<{ status: string }>('SELECT status FROM settlement_reconciliation_runs WHERE id = $1 FOR UPDATE', [id]);
      if (locked.rows[0]?.status !== 'running') return [];
      await this.insertLines(client, id, result.lines);
      for (const draft of result.exceptions) {
        const exceptionId = randomId('rx');
        const inserted = await client.query(
          `INSERT INTO settlement_exceptions (id, run_id, connector, kind, provider_reference, business_ref, statement_amount_minor, ledger_amount_minor, difference_minor, statement_line_ref, merchant_id, payment_intent_id, status, dedupe_key, created_at, mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', $13, $14, $15)
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING 1`,
          [exceptionId, id, run.connector, draft.kind, draft.providerReference, draft.businessRef, draft.statementAmountMinor, draft.ledgerAmountMinor, draft.differenceMinor, draft.statementLineRef, draft.merchantId, draft.paymentIntentId, createHash('sha256').update(`${run.mode}|${draft.dedupeKey}`).digest('hex'), now, run.mode],
        );
        // Solo una diferencia NUEVA avisa: repetir la corrida sobre el mismo periodo no reabre ni vuelve a notificar lo ya conocido.
        if (inserted.rows.length === 1) {
          await emitExceptionOpened(client, { exceptionId, mode: run.mode, connector: run.connector, kind: draft.kind, differenceMinor: draft.differenceMinor, paymentIntentId: draft.paymentIntentId, statementLineRef: draft.statementLineRef, merchantId: draft.merchantId, openedAt: now });
        }
      }
      await client.query(
        `UPDATE settlement_reconciliation_runs SET status = 'completed', matched_count = $2, exception_count = $3, ignored_count = $4, completed_at = $5 WHERE id = $1`,
        [id, result.matched, result.exceptions.length, result.ignored, now],
      );
      return result.confirmedPayouts;
    });

    // Un extracto que prueba que el banco pagó un payout en tránsito lo confirma. Fuera de la transacción: si falla, el barrido lo retoma.
    for (const payoutId of confirmed) {
      try {
        await this.payouts.confirm(payoutId, { state: 'paid', reference: `statement:${id}` });
      } catch (error) {
        this.logger.warn({ run: id, payout: payoutId, err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo confirmar el payout con el extracto');
      }
    }
  }

  private async payoutFacts(mode: PayMode, references: (string | null)[]): Promise<Map<string, PayoutFact>> {
    const ids = [...new Set(references.map((r) => /^(po_[a-z0-9]{10,40})(?::payout)?$/.exec(r ?? '')?.[1]).filter((v): v is string => Boolean(v)))];
    if (ids.length === 0) return new Map();
    const found = await this.pool.query<{ id: string; amount_minor: string; status: PayoutFact['status'] }>('SELECT id, amount_minor, status FROM settlement_payouts WHERE mode = $2 AND id = ANY($1::text[])', [ids, mode]);
    return new Map(found.rows.map((r) => [r.id, { amountMinor: Number(r.amount_minor), status: r.status }]));
  }

  private async insertLines(client: PoolClient, runIdValue: string, lines: ReturnType<typeof reconcile>['lines']): Promise<void> {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO settlement_statement_lines (run_id, line_ref, provider_reference, our_reference, direction, amount_minor, value_date, booked_at, outcome)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::date[], $8::timestamptz[], $9::text[])`,
        [
          runIdValue,
          chunk.map((l) => l.lineRef),
          chunk.map((l) => l.line.provider_reference),
          chunk.map((l) => l.line.our_reference),
          chunk.map((l) => l.line.direction),
          chunk.map((l) => l.line.amount_minor),
          chunk.map((l) => l.line.value_date),
          chunk.map((l) => l.line.booked_at),
          chunk.map((l) => l.outcome),
        ],
      );
    }
  }

  async listExceptions(rawQuery: unknown, mode: PayMode) {
    const q = parseOrThrow(exceptionListQuery, rawQuery);
    const cursor = q.starting_after ? decodeCursor(q.starting_after) : null;
    const { rows } = await this.pool.query<ExceptionRow>(
      `SELECT ${EXCEPTION_COLUMNS} FROM settlement_exceptions
        WHERE (mode = $5 OR mode IS NULL) AND ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [q.status ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, mode],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { rows: page, has_more: rows.length > q.limit, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** ¿Puede esta persona tomar esta decisión? `settlement_admin` incluye lo de `settlement_operator` (supuesto: ver DECISIONES-TOMADAS.md). */
  static authorize(operator: OperatorIdentity, resolution: 'request_adjustment' | 'dismiss'): boolean {
    if (operator.roles.includes(ROLE_ADMIN)) return true;
    return resolution === 'dismiss' && operator.roles.includes(ROLE_OPERATOR);
  }

  /**
   * `POST /reconciliation_exceptions/{id}/resolve`. Quién decide sale de la credencial (`operator.sub`), nunca del cuerpo. NO toca el
   * ledger: `request_adjustment` deja un pedido que sigue el flujo normal de asientos con su propia aprobación.
   *
   * @throws ProblemError `forbidden` si el rol no alcanza para esa decisión (se decide antes de la idempotencia, para no guardar el 403).
   */
  async resolve(rawId: string, rawBody: unknown, operator: OperatorIdentity, caller: string, mode: PayMode, idempotencyKey: string) {
    const id = exceptionId.safeParse(rawId);
    if (!id.success) throw new ProblemError('resource_not_found');
    const input = parseOrThrow(exceptionResolve, rawBody);
    if (!ReconciliationService.authorize(operator, input.resolution)) throw new ProblemError('forbidden');
    return this.idempotency.execute(
      { scope: `${caller}:${operator.sub}:${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/reconciliation_exceptions/${id.data}/resolve`, body: input }) },
      async () => {
        const row = await inTransaction(this.pool, async (client) => {
          const found = await client.query<ExceptionRow & { difference_minor: string }>(`SELECT ${EXCEPTION_COLUMNS} FROM settlement_exceptions WHERE id = $1 AND (mode = $2 OR mode IS NULL) FOR UPDATE`, [id.data, mode]);
          const current = found.rows[0];
          if (!current) throw new ProblemError('resource_not_found');
          if (current.status !== 'open') throw new ProblemError('invalid_state_transition', { detail: 'La excepción ya está cerrada' });
          const now = new Date();
          const updated = await client.query<ExceptionRow>(
            `UPDATE settlement_exceptions SET status = $2, resolution = $3, resolved_by = $4, resolution_note = $5, resolved_at = $6 WHERE id = $1 RETURNING ${EXCEPTION_COLUMNS}`,
            [id.data, input.resolution === 'dismiss' ? 'dismissed' : 'resolved', input.resolution, operator.sub, input.note, now],
          );
          if (input.resolution === 'request_adjustment') {
            await client.query('INSERT INTO settlement_adjustment_requests (exception_id, requested_by, difference_minor, note, created_at) VALUES ($1, $2, $3, $4, $5)', [id.data, operator.sub, current.difference_minor, input.note, now]);
          }
          await client.query(`INSERT INTO settlement_audit (actor, role, action, subject, detail, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [
            operator.sub,
            operator.roles.includes(ROLE_ADMIN) ? ROLE_ADMIN : ROLE_OPERATOR,
            `reconciliation_exception.${input.resolution}`,
            id.data,
            JSON.stringify({ difference_minor: Number(current.difference_minor) }),
            now,
          ]);
          return updated.rows[0];
        });
        return { status: 200, body: exceptionDto(row) };
      },
    );
  }
}
