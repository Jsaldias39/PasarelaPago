import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContractValidator } from '@pay/testing';
import { matchRoute } from '../../src/routes';
import { SAMPLES } from './samples';

/**
 * [DOBLE] de un servicio dueño de recursos públicos (pay-payments, pay-merchants, …). NO es el servicio real.
 * Cumple `public-v1.yaml`: toda respuesta que arma se valida contra el contrato (`violations` debe quedar vacío), y por
 * defecto aísla por comercio como lo haría el real (un recurso de otro comercio ⇒ 404 `resource_not_found`).
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type DoubleResult =
  | { readonly status: number; readonly body?: unknown; readonly raw?: Buffer; readonly headers?: Record<string, string> }
  | 'hang'
  | 'destroy';

export class UpstreamDouble {
  readonly requests: RecordedRequest[] = [];
  /** Respuestas que NO cumplen el contrato (debe quedar vacío en los niveles «correcto» y «límite»). */
  readonly violations: string[] = [];
  /** Sustituye el comportamiento por defecto (niveles «límite» e «inválido»). */
  override: ((request: RecordedRequest) => DoubleResult | Promise<DoubleResult>) | undefined;
  private readonly owned = new Map<string, Set<string>>();
  private server: Server | undefined;

  constructor(private readonly contract: ContractValidator) {}

  /** Declara que `merchantId` es dueño del recurso `id`. */
  own(merchantId: string, id: string): void {
    this.owned.set(merchantId, (this.owned.get(merchantId) ?? new Set()).add(id));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
          this.requests.push(recorded);
          const result = this.override ? await this.override(recorded) : this.defaultResult(recorded);
          if (result === 'hang') return; // nunca responde
          if (result === 'destroy') return void req.socket.destroy();
          const body = result.raw ?? (result.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(result.body)));
          res.writeHead(result.status, { ...(body.length > 0 && { 'content-type': result.status >= 400 ? 'application/problem+json' : 'application/json' }), ...result.headers });
          res.end(body);
        })();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private defaultResult(request: RecordedRequest): DoubleResult {
    const path = request.url.split('?')[0];
    const matched = matchRoute(request.method, path);
    if (!matched) return { status: 404, body: { type: 'urn:alovida:pay:problem:resource_not_found', title: 'No existe el recurso', status: 404, code: 'resource_not_found' } };
    const merchant = String(request.headers['x-merchant-id'] ?? '');
    // El id es el segmento que ocupa `{id}` en la plantilla (no se adivina por la forma del texto).
    const idIndex = matched.rule.template.split('/').indexOf('{id}');
    const id = idIndex >= 0 ? path.split('/')[idIndex] : undefined;
    // Aislamiento por comercio: si hay un id y no es de este comercio ⇒ 404 (nunca 403).
    if (id && !this.owned.get(merchant)?.has(id)) {
      const body = { type: 'urn:alovida:pay:problem:resource_not_found', title: 'No existe el recurso', status: 404, code: 'resource_not_found' };
      this.check(request, 404, body);
      return { status: 404, body };
    }
    const sample = SAMPLES[`${request.method} ${matched.rule.template}`];
    this.check(request, sample.status, sample.body);
    return { status: sample.status, body: sample.body };
  }

  private check(request: RecordedRequest, status: number, body: unknown): void {
    const errors = this.contract.validateResponse({ method: request.method, path: request.url.split('?')[0], status, body });
    if (errors.length > 0) this.violations.push(`${request.method} ${request.url} ${status}: ${errors.join('; ')}`);
  }
}
