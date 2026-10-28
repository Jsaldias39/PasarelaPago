import { randomUUID } from 'node:crypto';
import { arrivalOffsetsMs, type PlanOptions } from './plan.ts';
import { summarize, type Summary } from './stats.ts';

/**
 * Núcleo del generador de carga de T-01 (sin dependencias nuevas, Node puro). Crea intentos de pago QR contra la API PÚBLICA de pay-edge con claves `sk_test_`,
 * a una tasa abierta con rampa, con `Idempotency-Key` ÚNICAS (y una fracción repetida a propósito para probar la idempotencia bajo concurrencia), y después espera, por
 * condición, a que cada intento llegue a un estado terminal.
 */
export interface LoadConfig extends PlanOptions {
  readonly baseUrl: string;
  /** Claves `sk_test_…`; los pedidos se reparten entre ellas en turnos (el borde frena por clave). */
  readonly keys: readonly string[];
  readonly amounts: readonly number[];
  /** Fracción (0 a 1) de pedidos que se repiten, con la MISMA clave, enseguida y en paralelo. */
  readonly duplicateFraction: number;
  readonly requestTimeoutMs: number;
  readonly settleTimeoutSeconds: number;
  readonly pollConcurrency: number;
  readonly maxInFlight: number;
  readonly runId: string;
}

export interface CreatedIntent {
  readonly id: string;
  readonly key: string;
  readonly merchantIndex: number;
  readonly netMinor: number;
  readonly amountMinor: number;
  readonly createdAtMs: number;
}

export interface LoadResult {
  readonly config: Omit<LoadConfig, 'keys'> & { readonly keys: number };
  readonly planned: number;
  readonly sent: number;
  readonly answered: number;
  readonly byStatus: Record<string, number>;
  /** Por código de error del contrato (`code` del problem+json) y estado HTTP. */
  readonly byErrorCode: Record<string, number>;
  readonly status5xx: number;
  readonly status4xx: number;
  readonly status429: number;
  readonly noResponse: number;
  readonly runnerDropped: number;
  readonly createLatencyMs: Summary;
  /** Retraso entre el instante planificado y el de salida real: si crece, el generador es el cuello. */
  readonly sendLagMs: Summary;
  readonly created: number;
  readonly terminalByStatus: Record<string, number>;
  readonly failedByCode: Record<string, number>;
  readonly stuck: number;
  readonly stuckSample: string[];
  readonly timeToTerminalMs: Summary;
  readonly idempotencyViolations: number;
  readonly intents: CreatedIntent[];
  readonly succeeded: { id: string; merchantIndex: number; netMinor: number }[];
  readonly startedAt: string;
  readonly sendPhaseMs: number;
  readonly settlePhaseMs: number;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bump = (record: Record<string, number>, key: string) => {
  record[key] = (record[key] ?? 0) + 1;
};

interface PostOutcome {
  readonly status: number | null;
  readonly latencyMs: number;
  readonly body: unknown;
}

async function post(config: LoadConfig, key: string, idempotencyKey: string, amountMinor: number): Promise<PostOutcome> {
  const started = performance.now();
  try {
    const res = await fetch(`${config.baseUrl}/v1/payment_intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ amount_minor: amountMinor, currency: 'BOB', payment_method: { type: 'qr' } }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, latencyMs: performance.now() - started, body };
  } catch {
    // Corte, plazo vencido: no se sabe si el servidor lo ejecutó. Es AMBIGUO (regla 11), no un fallo: se cuenta aparte.
    return { status: null, latencyMs: performance.now() - started, body: undefined };
  }
}

export async function runLoad(config: LoadConfig): Promise<LoadResult> {
  if (config.keys.length === 0) throw new Error('hace falta al menos una clave sk_test_');
  for (const key of config.keys) if (!key.startsWith('sk_test_')) throw new Error('el runner de carga solo usa claves sk_test_ (sandbox); una clave live se rechaza');
  const offsets = arrivalOffsetsMs(config);
  const startedAtMs = Date.now();
  const t0 = performance.now();

  const byStatus: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  const latencies: number[] = [];
  const lags: number[] = [];
  const intents = new Map<string, CreatedIntent>();
  const idempotencyKeyToIntent = new Map<string, string>();
  let sent = 0;
  let answered = 0;
  let status5xx = 0;
  let status4xx = 0;
  let status429 = 0;
  let noResponse = 0;
  let dropped = 0;
  let idempotencyViolations = 0;
  let inFlight = 0;
  const pending = new Set<Promise<void>>();

  const record = (outcome: PostOutcome, key: string, merchantIndex: number, idempotencyKey: string, amountMinor: number) => {
    if (outcome.status === null) {
      noResponse += 1;
      return;
    }
    answered += 1;
    latencies.push(outcome.latencyMs);
    bump(byStatus, String(outcome.status));
    if (outcome.status === 429) status429 += 1;
    else if (outcome.status >= 500) status5xx += 1;
    else if (outcome.status >= 400) status4xx += 1;
    if (outcome.status >= 400) {
      const code = (outcome.body as { code?: unknown } | undefined)?.code;
      bump(byErrorCode, `${outcome.status} ${typeof code === 'string' ? code : 'sin_code'}`);
      return;
    }
    const body = outcome.body as { id?: string; net_minor?: number } | undefined;
    if (!body?.id) return;
    const previous = idempotencyKeyToIntent.get(idempotencyKey);
    if (previous !== undefined && previous !== body.id) idempotencyViolations += 1; // la MISMA clave devolvió un intento distinto: doble efecto
    idempotencyKeyToIntent.set(idempotencyKey, body.id);
    if (!intents.has(body.id)) intents.set(body.id, { id: body.id, key, merchantIndex, netMinor: body.net_minor ?? 0, amountMinor, createdAtMs: Date.now() });
  };

  for (let i = 0; i < offsets.length; i += 1) {
    const due = t0 + offsets[i]!;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    lags.push(Math.max(0, performance.now() - due));
    if (inFlight >= config.maxInFlight) {
      dropped += 1;
      continue;
    }
    const merchantIndex = i % config.keys.length;
    const key = config.keys[merchantIndex]!;
    const amount = config.amounts[i % config.amounts.length]!;
    const idempotencyKey = `load-${config.runId}-${i}`;
    const copies = Math.random() < config.duplicateFraction ? 2 : 1;
    for (let c = 0; c < copies; c += 1) {
      sent += 1;
      inFlight += 1;
      const task = post(config, key, idempotencyKey, amount)
        .then((outcome) => record(outcome, key, merchantIndex, idempotencyKey, amount))
        .finally(() => {
          inFlight -= 1;
          pending.delete(task);
        });
      pending.add(task);
    }
  }
  await Promise.all(pending);
  const sendPhaseMs = performance.now() - t0;

  // ── Espera a los estados terminales, por condición con plazo ──
  const settleStart = performance.now();
  const deadline = settleStart + config.settleTimeoutSeconds * 1000;
  const open = new Map(intents);
  const terminalByStatus: Record<string, number> = {};
  const failedByCode: Record<string, number> = {};
  const toTerminal: number[] = [];
  const succeeded: LoadResult['succeeded'] = [];
  const poll = async (intent: CreatedIntent): Promise<void> => {
    try {
      const res = await fetch(`${config.baseUrl}/v1/payment_intents/${intent.id}`, { headers: { authorization: `Bearer ${intent.key}`, accept: 'application/json' }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (res.status !== 200) return;
      const body = (await res.json()) as { status?: string; last_error?: { code?: string } | null; net_minor?: number };
      if (body.status && TERMINAL.has(body.status)) {
        open.delete(intent.id);
        bump(terminalByStatus, body.status);
        toTerminal.push(Date.now() - intent.createdAtMs);
        if (body.status === 'failed') bump(failedByCode, body.last_error?.code ?? 'sin_code');
        if (body.status === 'succeeded') succeeded.push({ id: intent.id, merchantIndex: intent.merchantIndex, netMinor: body.net_minor ?? intent.netMinor });
      }
    } catch {
      // se reintenta en la próxima ronda
    }
  };
  while (open.size > 0 && performance.now() < deadline) {
    const batch = [...open.values()];
    for (let i = 0; i < batch.length; i += config.pollConcurrency) {
      if (performance.now() >= deadline) break;
      await Promise.all(batch.slice(i, i + config.pollConcurrency).map(poll));
    }
    if (open.size > 0) await sleep(Math.min(1000, Math.max(0, deadline - performance.now())));
  }
  const settlePhaseMs = performance.now() - settleStart;

  const { keys, ...rest } = config;
  return {
    config: { ...rest, keys: keys.length },
    planned: offsets.length,
    sent,
    answered,
    byStatus,
    byErrorCode,
    status5xx,
    status4xx,
    status429,
    noResponse,
    runnerDropped: dropped,
    createLatencyMs: summarize(latencies),
    sendLagMs: summarize(lags),
    created: intents.size,
    terminalByStatus,
    failedByCode,
    stuck: open.size,
    stuckSample: [...open.keys()].slice(0, 10),
    timeToTerminalMs: summarize(toTerminal),
    idempotencyViolations,
    intents: [...intents.values()],
    succeeded,
    startedAt: new Date(startedAtMs).toISOString(),
    sendPhaseMs,
    settlePhaseMs,
  };
}

export const newRunId = (): string => randomUUID().slice(0, 8);
