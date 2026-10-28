import { createHash } from 'node:crypto';
import { CONTRACTS } from './contracts';
import { DoubleServer, problem, type DoubleRequest, type DoubleResponse } from './server';

export type RiskMode =
  | 'allow' | 'deny' | 'review' | 'down' | 'hang'
  | { slowMs: number }
  /** La PRIMERA llamada de cada clave tarda `firstSlowMs` (más que el timeout del cliente) y mientras sigue en curso otra con la MISMA clave recibe `409 idempotency_request_in_progress`; después se repite la respuesta guardada. Es lo que hace el pay-risk real. */
  | { firstSlowMs: number }
  /** Las primeras `hangFirst` llamadas no responden (el cliente vence por timeout) y las siguientes evalúan normal. */
  | { hangFirst: number }
  /** Las primeras `inProgressFirst` llamadas reciben `409 idempotency_request_in_progress` y las siguientes evalúan normal. */
  | { inProgressFirst: number }
  /** TODA llamada recibe `409 idempotency_request_in_progress` (la evaluación nunca termina). */
  | 'in_progress'
  /** TODA llamada recibe un 4xx declarado que NO es una decisión (`422 validation_failed`): un error de integración nuestro. */
  | 'rejects';

const idOf = (prefix: string, seed: string) => `${prefix}_${createHash('sha1').update(seed).digest('hex').slice(0, 14)}`;

const normalize = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

interface AssessmentBody {
  payment_intent_id: string;
  screening?: { merchant_name?: string; merchant_entity_type?: string; name?: string; entity_type?: string };
}

/**
 * [DOBLE] de pay-risk (P5): implementa `internal-risk-v1`. Modo cambiable en caliente para los escenarios.
 * Cribado como `internal-risk-v1` (D-29, UNA evaluación con las dos partes): `screening.merchant_name` es la razón social del comercio y SIEMPRE debe venir;
 * `screening.name` es el pagador y es opcional (un invitado sin nombre no bloquea). Gana la parte más grave: un nombre de `sanctions` en CUALQUIERA de las
 * dos ⇒ `deny/sanctions_match` (screened); sin `merchant_name` y sin coincidencia del pagador ⇒ `review/screening_not_provided` (nunca `allow`; el llamador
 * lo trata como deny, D-30); con `merchant_name` y sin coincidencias ⇒ `allow/ok`. `requireScreening = false` apaga la exigencia de `merchant_name`.
 */
export class RiskDouble {
  mode: RiskMode = 'allow';
  requireScreening = true;
  /** Nombres en la lista de sanciones del doble (se comparan sin tildes ni mayúsculas). */
  readonly sanctions = new Set<string>();
  readonly server: DoubleServer;
  private readonly seen = new Map<string, { status: number; assessment: unknown }>();
  private readonly inFlightUntil = new Map<string, number>();
  private calls = 0;
  /** Cuántas llamadas recibió desde el último `reset()` (todas, incluidas las que dieron 409 o colgaron). */
  get callCount(): number {
    return this.calls;
  }

  /** Vuelve al estado inicial: modo `allow`, sin respuestas guardadas ni evaluaciones en curso, contador en cero. */
  reset(): void {
    this.mode = 'allow';
    this.seen.clear();
    this.inFlightUntil.clear();
    this.calls = 0;
  }

  constructor() {
    this.server = new DoubleServer(CONTRACTS.risk, (req) => this.handle(req));
  }

  start = () => this.server.start();
  stop = () => this.server.stop();

  private handle(req: DoubleRequest): DoubleResponse {
    if (req.method !== 'POST' || req.path !== '/assessments') return problem('resource_not_found', 404);
    this.calls += 1;
    if (this.mode === 'down') return problem('risk_unavailable', 503);
    if (this.mode === 'hang') return { status: 200, hang: true };
    if (this.mode === 'in_progress') return problem('idempotency_request_in_progress', 409);
    if (this.mode === 'rejects') return problem('validation_failed', 422);
    if (typeof this.mode === 'object' && 'hangFirst' in this.mode && this.calls <= this.mode.hangFirst) return { status: 200, hang: true };
    if (typeof this.mode === 'object' && 'inProgressFirst' in this.mode && this.calls <= this.mode.inProgressFirst) return problem('idempotency_request_in_progress', 409);
    const key = String(req.headers['idempotency-key'] ?? '');
    const body = req.body as AssessmentBody;
    const until = this.inFlightUntil.get(key);
    if (until !== undefined && Date.now() < until) return problem('idempotency_request_in_progress', 409);
    const replayed = this.seen.get(key);
    if (replayed) return { status: 200, body: replayed.assessment };
    const delayMs = typeof this.mode === 'object' ? ('slowMs' in this.mode ? this.mode.slowMs : 'firstSlowMs' in this.mode ? this.mode.firstSlowMs : undefined) : undefined;
    if (typeof this.mode === 'object' && 'firstSlowMs' in this.mode) this.inFlightUntil.set(key, Date.now() + this.mode.firstSlowMs);
    let decision: 'allow' | 'review' | 'deny';
    let reason: string;
    let screened = false;
    if (this.mode === 'deny') [decision, reason] = ['deny', 'amount_over_limit'];
    else if (this.mode === 'review') [decision, reason] = ['review', 'sanctions_possible_match'];
    else {
      const listed = (name: string | undefined) => name !== undefined && this.sanctions.has(normalize(name));
      const screening = body.screening;
      if (listed(screening?.merchant_name) || listed(screening?.name)) [decision, reason, screened] = ['deny', 'sanctions_match', true];
      else if (!screening?.merchant_name) [decision, reason] = this.requireScreening ? ['review', 'screening_not_provided'] : ['allow', 'no_limits_configured'];
      else [decision, reason, screened] = ['allow', 'ok', true];
    }
    const assessment = {
      id: idOf('ra', key),
      object: 'risk_assessment',
      payment_intent_id: body.payment_intent_id,
      decision,
      reason_code: reason,
      rule_version: 1,
      screened,
      created_at: new Date().toISOString(),
    };
    this.seen.set(key, { status: 201, assessment });
    return { status: 201, body: assessment, ...(delayMs ? { delayMs } : {}) };
  }
}
