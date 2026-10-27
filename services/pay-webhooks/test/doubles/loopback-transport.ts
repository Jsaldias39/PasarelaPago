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
  constructor(private readonly routes: Map<string, string> = new Map()) {}

  route(hostname: string, baseUrl: string): void {
    this.routes.set(hostname, baseUrl);
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const { target, headers, body } = request;
    this.calls.push({ hostname: target.hostname, ip: target.ip, path: target.path, headers, body });
    const base = this.routes.get(target.hostname);
    if (!base) throw new TransportError('connection_error');
    try {
      const response = await fetch(`${base}${target.path}`, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs) });
      await response.arrayBuffer();
      return { status: response.status };
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new TransportError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection_error');
    }
  }
}
