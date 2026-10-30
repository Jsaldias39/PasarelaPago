import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { IdempotencyStore } from '@pay/idempotency';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { newAssessmentId } from '../db';
import { rethrowStoredProblem } from '../idempotent';
import { evaluate, type History, type RuleSet } from '../rules/engine';
import { CLOCK, type Clock, RuleSetsService } from '../rules/rule-sets.service';
import { combineScreenings } from '../screening/combine';
import { SANCTIONS_SCREENER, type SanctionsScreener, type ScreeningResult } from '../screening/screener';
import { RISK_SETTINGS, type RiskSettings } from '../settings';

export interface AssessmentInput {
  merchant_id: string;
  payment_intent_id: string;
  amount_minor: number;
  currency: 'BOB';
  method: 'qr' | 'card' | 'bank_transfer' | 'wallet';
  payer_fingerprint?: string;
  /**
   * D-29. `merchant_name` (nombre legal del comercio) es lo que SIEMPRE se criba; `name` es el del pagador, solo si lo dio.
   * `merchant_*` y `name`/`entity_type` son los campos de `AssessmentCreate.screening` de internal-risk-v1.yaml (PR-17 aplicada); ninguno es `required`.
   */
  screening?: { merchant_name?: string; merchant_entity_type?: 'person' | 'business'; name?: string; entity_type?: 'person' | 'business' };
}

export interface AssessmentView {
  id: string;
  object: 'risk_assessment';
  payment_intent_id: string;
  decision: 'allow' | 'review' | 'deny';
  reason_code: string;
  rule_version: number;
  screened: boolean;
  created_at: string;
}

const VIEW_COLUMNS = 'id, payment_intent_id, decision, reason_code, rule_version, screened, created_at';

function toView(row: Record<string, unknown>): AssessmentView {
  return {
    id: row.id as string,
    object: 'risk_assessment',
    payment_intent_id: row.payment_intent_id as string,
    decision: row.decision as AssessmentView['decision'],
    reason_code: row.reason_code as string,
    rule_version: Number(row.rule_version),
    screened: row.screened as boolean,
    created_at: (row.created_at as Date).toISOString(),
  };
}

/** La Paz es UTC-4 todo el año (Bolivia no usa horario de verano). */
const localHour = (now: Date): number => (now.getUTCHours() + 20) % 24;

/**
 * El cribado no pudo completarse (timeout, caída, respuesta inválida): eso NO es un resultado sobre la persona, es un resultado sobre el cribado.
 * La evaluación se responde igual (fail-closed: `review`/`screening_unavailable`, `screened: false`) pero NO queda congelada bajo la Idempotency-Key:
 * el almacén de idempotencia suelta la clave (no es un error de negocio ni se completa) y un reintento con la MISMA clave y el MISMO cuerpo vuelve a cribar.
 */
class IncompleteScreening extends Error {
  constructor(readonly view: AssessmentView) {
    super('screening_incomplete');
  }
}

@Injectable()
export class AssessmentsService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RISK_SETTINGS) private readonly settings: RiskSettings,
    @Inject(SANCTIONS_SCREENER) private readonly screener: SanctionsScreener,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ruleSets: RuleSetsService,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /** Huella irreversible (HMAC) para guardar y comparar sin conservar el valor original. */
  digest(purpose: string, value: string): string {
    return createHmac('sha256', this.settings.payerHashKey).update(`${purpose}|${value}`).digest('hex');
  }

  /**
   * Evalúa un cobro. Idempotente por `(servicio llamador, Idempotency-Key)`: repetir devuelve la MISMA decisión y versión
   * de reglas sin volver a cribar. El nombre se usa en memoria para el cribado y no se guarda ni se registra.
   */
  async create(callerService: string, idempotencyKey: string, requestHash: string, input: AssessmentInput): Promise<{ status: 200 | 201; body: AssessmentView }> {
    let result;
    try {
      result = await this.runOnce(callerService, idempotencyKey, requestHash, input);
    } catch (error) {
      // Decisión NO definitiva: se responde, pero la clave quedó libre (ver `IncompleteScreening`). Cada intento deja su propio rastro.
      if (error instanceof IncompleteScreening) return { status: 201, body: error.view };
      throw error;
    }
    rethrowStoredProblem(result);
    return { status: result.replayed ? 200 : 201, body: result.body };
  }

  private async runOnce(callerService: string, idempotencyKey: string, requestHash: string, input: AssessmentInput) {
    return this.idempotency.execute({ scope: callerService, key: idempotencyKey, requestHash }, async (ctx) => {
      if (ctx.recoveryPoint !== 'started') {
        // La evaluación ya se escribió pero no se guardó la respuesta: se reconstruye desde el rastro.
        const { rows } = await this.pool.query(`SELECT ${VIEW_COLUMNS} FROM risk_assessments WHERE caller_service = $1 AND request_key = $2`, [callerService, idempotencyKey]);
        if (rows.length === 0) throw new ProblemError('invalid_state_transition', { detail: 'La evaluación anterior quedó a medias: reintentá con otra Idempotency-Key' });
        return { status: 201, body: toView(rows[0]) };
      }
      const started = performance.now();
      // El cribado va FUERA de la transacción y de los candados: es una llamada de red.
      // D-29: sin el nombre del COMERCIO no hay cribado (review). El pagador sin nombre (invitado) no bloquea. Un nombre en blanco, válido para el
      // contrato, equivale a no haberlo mandado.
      const merchantName = input.screening?.merchant_name?.trim();
      const payerName = input.screening?.name?.trim();
      let screening: ScreeningResult | 'not_provided' = 'not_provided';
      const [merchantResult, payerResult] = await Promise.all([
        // Un comercio es una persona jurídica: sin tipo explícito se busca como empresa (UNA búsqueda, la de menor costo; supuesto D5-40).
        merchantName ? this.screener.screen(merchantName, input.screening?.merchant_entity_type ?? 'business') : undefined,
        payerName ? this.screener.screen(payerName, input.screening?.entity_type) : undefined,
      ]);
      if (merchantResult) {
        screening = combineScreenings([{ party: 'merchant', result: merchantResult }, ...(payerResult ? [{ party: 'payer' as const, result: payerResult }] : [])]);
      } else if (payerResult?.outcome === 'match') {
        // Falta el nombre del comercio (review), pero una coincidencia fuerte del pagador ya es un `deny`: no se oculta.
        screening = { ...payerResult, party: 'payer' };
      }
      if (screening !== 'not_provided' && screening.outcome === 'unavailable') {
        // Rastro del intento fallido SIN avanzar el punto de recuperación de la clave (no `ctx.atomic`) y con una clave de rastro propia: el índice único
        // `(caller_service, request_key)` sigue reservado para la evaluación DEFINITIVA, que llega con el reintento.
        throw new IncompleteScreening(await this.recordAttempt(callerService, `${idempotencyKey}~sin-cribar~${randomUUID().slice(0, 8)}`, input, screening, started));
      }
      const view = await ctx.atomic('evaluated', (client) => this.decideAndRecord(client, callerService, idempotencyKey, input, screening, started));
      return { status: 201, body: view };
    });
  }

  /** Una transacción propia para el rastro de una evaluación no definitiva (los candados por comercio y pagador se toman igual). */
  private async recordAttempt(callerService: string, traceKey: string, input: AssessmentInput, screening: ScreeningResult, started: number): Promise<AssessmentView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const view = await this.decideAndRecord(client, callerService, traceKey, input, screening, started);
      await client.query('COMMIT');
      return view;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lock(client: Queryable, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  private async history(client: Queryable, rules: RuleSet, input: AssessmentInput, payerHash: string | null, now: Date): Promise<History> {
    const attempts = async (column: 'payer_hash' | 'merchant_id', value: string, windowSeconds: number): Promise<number> => {
      // Velocidad: intentos DISTINTOS (el grupo es el intento), sin contar el que se está evaluando.
      const { rows } = await client.query(
        `SELECT count(DISTINCT payment_intent_id)::int AS n FROM risk_assessments
          WHERE ${column} = $1 AND created_at > $2::timestamptz - make_interval(secs => $3) AND payment_intent_id <> $4`,
        [value, now, windowSeconds, input.payment_intent_id],
      );
      return Number(rows[0].n);
    };
    const committed = async (column: 'payer_hash' | 'merchant_id', value: string): Promise<bigint> => {
      // GRUPO = el INTENTO (`payment_intent_id`), no la evaluación ni la `Idempotency-Key`: `pay-payments` evalúa un mismo intento más de una
      // vez (comercio y pagador, claves `${intent}:risk` y `${intent}:risk:payer`) y eso NO suma dos veces. Cada intento cuenta UNA vez, con el
      // MAYOR importe evaluado del intento (no «el de la primera»: dos evaluaciones pueden tener la misma `created_at` y el orden por `id` es
      // aleatorio; el máximo no depende del orden y no se esquiva re-evaluando con un importe menor), y solo si NINGUNA de sus evaluaciones lo
      // rechazó (un deny en cualquiera lo deja sin efecto).
      const { rows } = await client.query(
        `SELECT COALESCE(sum(amount), 0)::text AS total FROM (
           SELECT payment_intent_id, max(amount_minor) AS amount FROM risk_assessments
            WHERE ${column} = $1 AND created_at > $2::timestamptz - interval '24 hours' AND payment_intent_id <> $3
            GROUP BY payment_intent_id) per_intent
          WHERE NOT EXISTS (SELECT 1 FROM risk_assessments d WHERE d.payment_intent_id = per_intent.payment_intent_id AND d.decision = 'deny')`,
        [value, now, input.payment_intent_id],
      );
      return BigInt(rows[0].total as string);
    };
    return {
      payerAttempts: rules.payerVelocity && payerHash ? await attempts('payer_hash', payerHash, rules.payerVelocity.windowSeconds) : 0,
      merchantAttempts: rules.merchantVelocity ? await attempts('merchant_id', input.merchant_id, rules.merchantVelocity.windowSeconds) : 0,
      payerDailyMinor: rules.payerDailyAmountMinor !== null && payerHash ? await committed('payer_hash', payerHash) : 0n,
      merchantDailyMinor: rules.merchantDailyAmountMinor !== null ? await committed('merchant_id', input.merchant_id) : 0n,
    };
  }

  private async decideAndRecord(
    client: Queryable,
    callerService: string,
    idempotencyKey: string,
    input: AssessmentInput,
    screening: ScreeningResult | 'not_provided',
    started: number,
  ): Promise<AssessmentView> {
    const now = this.clock();
    const rules = await this.ruleSets.current(client, now);
    // Una huella vacía (válida para el contrato) equivale a no haberla mandado.
    const payerHash = input.payer_fingerprint ? this.digest('payer', input.payer_fingerprint) : null;
    // Los límites cuentan lo ya evaluado: dos evaluaciones simultáneas del mismo comercio o pagador se serializan
    // (si no, ambas verían n-1 y pasarían). Solo se toma el candado si hay un límite que lo necesite; siempre en el mismo orden.
    if (rules.merchantVelocity || rules.merchantDailyAmountMinor !== null) await this.lock(client, `risk:merchant:${input.merchant_id}`);
    if (payerHash && (rules.payerVelocity || rules.payerDailyAmountMinor !== null)) await this.lock(client, `risk:payer:${payerHash}`);

    const history = await this.history(client, rules, input, payerHash, now);
    const verdict = evaluate(rules, { amountMinor: BigInt(input.amount_minor), localHour: localHour(now), payerKnown: payerHash !== null, screening }, history);
    const scored = screening !== 'not_provided' && screening.topScore !== undefined ? screening : undefined;
    const { rows } = await client.query(
      `INSERT INTO risk_assessments (id, caller_service, request_key, merchant_id, payment_intent_id, amount_minor, currency, method, payer_hash, decision,
          reason_code, reason_codes, rule_version, screened, screening_top_score, screening_list, screening_source_id, screening_party, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING ${VIEW_COLUMNS}`,
      [
        newAssessmentId(), callerService, idempotencyKey, input.merchant_id, input.payment_intent_id, input.amount_minor, input.currency, input.method, payerHash,
        verdict.decision, verdict.reasonCode, verdict.reasonCodes, rules.version, verdict.screened, scored?.topScore ?? null, scored?.list ?? null, scored?.sourceId ?? null, scored?.party ?? null,
        Math.round(performance.now() - started), now,
      ],
    );
    return toView(rows[0]);
  }

  async get(callerService: string, id: string): Promise<AssessmentView> {
    const { rows } = await this.pool.query(`SELECT ${VIEW_COLUMNS} FROM risk_assessments WHERE id = $1 AND caller_service = $2`, [id, callerService]);
    if (rows.length === 0) throw new ProblemError('resource_not_found');
    return toView(rows[0]);
  }
}
