import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SeededMerchant } from './seed.ts';
import { ALL_SERVICES, type ServiceName } from './services.ts';
import { Jaeger, serverSpanOf, viewsOf, type JaegerTrace, type SpanView } from './jaeger.ts';
import { until } from './wait.ts';
import type { HttpResult, Stack } from '../stack.ts';

/**
 * Sonda de trazas del arnés (P1.H2.M3): manda peticiones a la API pública de pay-edge con un `traceparent` / `x-request-id` a elección, halla su traza en el Jaeger REAL del
 * Compose por un user-agent único (así no hace falta conocer el traceId, que el borde puede abrir) y mira los logs de los servicios. La usan el flujo
 * `flows/traza-jaeger.e2e.ts` (lo que hoy es verdad) y `pending/traza-jaeger-arbol.e2e.ts` (lo que el contrato pide y hoy no se cumple).
 */

/** Variables de entorno que hacen que los 11 servicios (y pay-mockbank) exporten sus trazas al Jaeger del Compose. Único ajuste del arnés para esta prueba. */
export function otelEnvOverrides(jaeger: Jaeger): Record<string, Record<string, string>> {
  const otel = { OTEL_EXPORTER_OTLP_ENDPOINT: jaeger.endpoints.otlpUrl, OTEL_BSP_SCHEDULE_DELAY: '300' };
  return Object.fromEntries(ALL_SERVICES.map((name) => [name, otel]));
}

export interface SendInit {
  readonly traceparent?: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly json?: unknown;
  /** Cuerpo crudo (para mandar un JSON roto). */
  readonly body?: string;
}

export interface Sent {
  readonly res: HttpResult;
  readonly ua: string;
  /** Instante (µs) un poco antes de enviar: cota inferior para buscar en Jaeger. */
  readonly sinceUs: number;
}

export const nowUs = (): number => Date.now() * 1000;
export const randomTraceId = (): string => randomBytes(16).toString('hex');
export const randomSpanId = (): string => randomBytes(8).toString('hex');

export class TraceProbe {
  readonly runTag = randomBytes(4).toString('hex');
  private counter = 0;
  /** Cada traza leída de Jaeger, por traceId (para escanearlas al final). */
  readonly seen = new Map<string, JaegerTrace>();

  constructor(
    readonly stack: Stack,
    readonly merchant: SeededMerchant,
    readonly jaeger: Jaeger,
  ) {}

  /** Una petición a pay-edge. El user-agent es único por petición; la clave de idempotencia también. */
  async send(label: string, init: SendInit = {}): Promise<Sent> {
    this.counter += 1;
    const ua = `e2e-traza/${this.runTag}/${label}`;
    const sinceUs = nowUs() - 2_000_000;
    const method = init.method ?? 'POST';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.merchant.token}`,
      'user-agent': ua,
      ...(method === 'POST' ? { 'idempotency-key': `traza-${this.runTag}-${String(this.counter).padStart(3, '0')}` } : {}),
      ...(init.traceparent !== undefined ? { traceparent: init.traceparent } : {}),
      ...(init.requestId !== undefined ? { 'x-request-id': init.requestId } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const res = await this.stack.call('pay-edge', method, init.path ?? '/v1/payment_intents', { headers, ...(init.json !== undefined ? { json: init.json } : {}), ...(init.body !== undefined ? { body: init.body } : {}), timeoutMs: 30_000 });
    return { res, ua, sinceUs };
  }

  /**
   * Espera (por condición) a que Jaeger tenga la traza del user-agent con lo que `ready` pida, y a que deje de crecer (dos lecturas seguidas con el mismo número de spans:
   * el SDK exporta por lotes y Jaeger indexa con retraso, y un span más tardío no debe invalidar la lectura).
   */
  async traceOf(label: string, sent: Pick<Sent, 'ua' | 'sinceUs'>, ready: (views: SpanView[]) => boolean = (v) => serverSpanOf(v, 'pay-edge') !== undefined): Promise<JaegerTrace> {
    const first = await until(
      `Jaeger indexa la traza de «${label}»`,
      async () => (await this.jaeger.search({ service: 'pay-edge', tags: { 'user_agent.original': sent.ua }, startUs: sent.sinceUs, endUs: nowUs() + 600_000_000 })).find((t) => ready(viewsOf(t))),
      (t) => t !== undefined,
      90_000,
      500,
    );
    let previous = -1;
    const settled = await until(
      `la traza de «${label}» deja de crecer`,
      async () => {
        const t = (await this.jaeger.trace(first!.traceID)) ?? first!;
        const grew = t.spans.length !== previous;
        previous = t.spans.length;
        return { t, grew };
      },
      (r) => !r.grew,
      30_000,
      600,
    );
    this.seen.set(settled.t.traceID, settled.t);
    return settled.t;
  }

  /**
   * El span servidor de pay-payments que atendió la llamada del borde, buscado por TIEMPO: cae dentro de la ventana del span servidor del borde. Sirve para encontrarlo cuando NO
   * está en la traza del borde (el caso que se mide). Devuelve la traza que lo contiene.
   */
  async paymentsCounterpart(edgeTrace: JaegerTrace): Promise<{ trace: JaegerTrace; span: SpanView } | undefined> {
    const edge = serverSpanOf(viewsOf(edgeTrace), 'pay-edge');
    if (!edge) return undefined;
    const found = await until(
      'Jaeger indexa el span de pay-payments que atendió la llamada del borde',
      async () => {
        const traces = await this.jaeger.search({ service: 'pay-payments', startUs: edge.startUs - 1_000_000, endUs: edge.startUs + edge.durationUs + 1_000_000, limit: 100 });
        for (const trace of traces) {
          const span = viewsOf(trace).find((v) => v.service === 'pay-payments' && v.kind === 'server' && v.operation === 'POST /payment_intents' && v.startUs >= edge.startUs && v.startUs <= edge.startUs + edge.durationUs);
          if (span) return { trace, span };
        }
        return undefined;
      },
      (r) => r !== undefined,
      60_000,
      500,
    );
    return found;
  }

  /** ¿Hay en el log del servicio una línea de acceso con ESTE id de petición? (los logs son JSON de pino: `req.id`). */
  hasAccessLog(service: ServiceName, requestId: string): boolean {
    const file = this.stack.services[service].logFile;
    if (!existsSync(file)) return false;
    return readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => {
        if (!line.includes(requestId)) return false;
        try {
          return (JSON.parse(line) as { req?: { id?: string } }).req?.id === requestId;
        } catch {
          return false;
        }
      });
  }

  /** Espera (por condición) a que los logs de todos esos servicios tengan el request_id. */
  logsCarry(requestId: string, services: readonly ServiceName[]): Promise<boolean[]> {
    return until(`los logs de ${services.join(' y ')} llevan el request_id ${requestId}`, async () => services.map((s) => this.hasAccessLog(s, requestId)), (r) => r.every(Boolean), 30_000, 300);
  }
}

/** Cuerpo de un cobro QR sintético. */
export const qrIntent = (extra: Record<string, unknown> = {}) => ({ amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' }, ...extra });

/** Hay span servidor del borde Y de pay-payments en la traza. */
export const hasEdgeAndPayments = (views: SpanView[]): boolean => serverSpanOf(views, 'pay-edge') !== undefined && serverSpanOf(views, 'pay-payments') !== undefined;
