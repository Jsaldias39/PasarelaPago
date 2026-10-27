import { TransportError, type DeliveryTransport, type TransportRequest, type TransportResponse } from '../../src/ssrf/https-transport';

export interface TransportCall {
  readonly hostname: string;
  /** La IP pública que el guard fijó: la entrega real conectaría a ESTA dirección. */
  readonly ip: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * [DOBLE] de la red de salida. Cumple `DeliveryTransport` pero, en vez de conectar a Internet, reenvía la petición a un
 * receptor local según el NOMBRE del destino. Todo lo anterior (guard de SSRF, resolución y fijado de IP, firma, reintentos)
 * es código real; lo único simulado es el último salto de red. El transporte HTTPS real se prueba aparte (ssrf.spec.ts).
 */
export class LoopbackTransport implements DeliveryTransport {
  readonly calls: TransportCall[] = [];
  /** Demora artificial por nombre de destino (simula un receptor lento). */
  readonly delays = new Map<string, number>();
  /** Instante (ms) en que terminó cada llamada, por `webhook-id` y destino. */
  readonly finished: { hostname: string; webhookId: string; at: number }[] = [];
  inFlight = new Map<string, number>();
  maxInFlight = new Map<string, number>();
  constructor(private readonly routes: Map<string, string> = new Map()) {}

  route(hostname: string, baseUrl: string): void {
    this.routes.set(hostname, baseUrl);
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const { target, headers, body } = request;
    this.calls.push({ hostname: target.hostname, ip: target.ip, path: target.path, headers, body });
    const base = this.routes.get(target.hostname);
    if (!base) throw new TransportError('connection_error');
    const current = (this.inFlight.get(target.hostname) ?? 0) + 1;
    this.inFlight.set(target.hostname, current);
    this.maxInFlight.set(target.hostname, Math.max(this.maxInFlight.get(target.hostname) ?? 0, current));
    try {
      const delay = this.delays.get(target.hostname);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await fetch(`${base}${target.path}`, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs) });
      await response.arrayBuffer();
      return { status: response.status };
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new TransportError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection_error');
    } finally {
      this.inFlight.set(target.hostname, (this.inFlight.get(target.hostname) ?? 1) - 1);
      this.finished.push({ hostname: target.hostname, webhookId: headers['webhook-id'], at: Date.now() });
    }
  }
}
