import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadContract, type ContractValidator } from '@pay/testing';

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly at: number;
}

export interface DoubleRequest extends RecordedCall {
  readonly query: URLSearchParams;
}

export interface DoubleResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Espera antes de responder (simular lentitud). */
  readonly delayMs?: number;
  /** No responder nunca (simular un colgado); el cliente tiene que cortar por timeout. */
  readonly hang?: boolean;
}

export type DoubleHandler = (request: DoubleRequest) => DoubleResponse | Promise<DoubleResponse>;

/**
 * Servidor HTTP real que hace de DOBLE de otro servicio (regla 65). Es honesto de dos maneras:
 *  - todo lo que recibe se valida contra el contrato OpenAPI del servicio que simula (`violations` lista lo que no cumple);
 *  - todo lo que responde también (si el doble se sale del contrato, lanza: un doble que no cumple su contrato no prueba nada).
 * NUNCA es el colaborador real: cada doble se nombra `[DOBLE]` en sus pruebas.
 */
export class DoubleServer {
  readonly calls: DoubleRequest[] = [];
  /** Peticiones que NO cumplen el contrato del servicio simulado. Las pruebas exigen que esté vacío. */
  readonly violations: string[] = [];
  private server: Server | undefined;
  private contract: ContractValidator | undefined;
  private readonly pending = new Set<ServerResponse>();
  url = '';

  constructor(
    private readonly contractPath: string,
    private readonly handler: DoubleHandler,
  ) {}

  async start(): Promise<string> {
    this.contract = await loadContract(this.contractPath);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const res of this.pending) res.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  callsTo(method: string, pathPattern: RegExp): DoubleRequest[] {
    return this.calls.filter((c) => c.method === method && pathPattern.test(c.path));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://double');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const call: DoubleRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, at: Date.now() };
    this.calls.push(call);
    if (body !== undefined) {
      for (const e of this.contract!.validateRequest({ method: call.method, path: call.path, body })) this.violations.push(`${call.method} ${call.path}: ${e}`);
    } else if (this.contract!.validateRequest({ method: call.method, path: call.path, body: undefined }).some((e) => e.includes('no define'))) {
      this.violations.push(`${call.method} ${call.path}: ruta fuera del contrato`);
    }
    let out: DoubleResponse;
    try {
      out = await this.handler(call);
    } catch (error) {
      res.writeHead(500).end(String(error));
      return;
    }
    if (out.hang) {
      this.pending.add(res);
      return;
    }
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    if (out.body !== undefined) {
      const errors = this.contract!.validateResponse({ method: call.method, path: call.path, status: out.status, body: out.body });
      if (errors.length > 0) {
        res.writeHead(500).end(`El doble se salió de su contrato (${call.method} ${call.path} ${out.status}): ${errors.join('; ')}`);
        return;
      }
    }
    res.writeHead(out.status, { 'content-type': out.status >= 400 ? 'application/problem+json' : 'application/json', ...(out.headers ?? {}) });
    res.end(out.body === undefined ? undefined : JSON.stringify(out.body));
  }
}

export function problem(code: string, status: number, detail?: string): DoubleResponse {
  return {
    status,
    body: { type: `urn:alovida:pay:problem:${code}`, title: code, status, code, ...(detail ? { detail } : {}) },
  };
}
