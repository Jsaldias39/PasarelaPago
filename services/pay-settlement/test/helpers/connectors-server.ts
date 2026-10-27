import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { problem as problemBody, type ProblemCode } from '@pay/problem';
import type { ContractValidator } from '@pay/testing';

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

/** Qué hace el servidor ante la próxima llamada a una ruta. `contract` = respuesta que SÍ cumple el contrato; el resto simula fallos ajenos. */
export type Behavior =
  | { kind: 'contract'; status: number; body: unknown; contentType?: string }
  | { kind: 'raw'; status: number; body: string; contentType?: string }
  | { kind: 'hang' }
  | { kind: 'cut' };

const PROBLEM = 'application/problem+json';

/** Un `Problem` real del catálogo de `@pay/problem` (el mismo que arma el servicio de verdad). */
export const problem = (status: number, code: ProblemCode): Behavior => ({ kind: 'contract', status, contentType: PROBLEM, body: problemBody(code) });

export const transfer = (status: 'pending' | 'in_transit' | 'paid' | 'failed', reference: string, extra: object = {}): Behavior => ({
  kind: 'contract',
  status: 200,
  body: {
    id: 'tr_abcdefghijkl',
    object: 'transfer',
    reference,
    connector: 'mock',
    mode: 'sandbox',
    amount_minor: 9000,
    currency: 'BOB',
    status,
    failure_code: status === 'failed' ? 'rejected_by_bank' : null,
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:00.000Z',
    ...extra,
  },
});

/**
 * [DOBLE] de pay-connectors como servidor HTTP REAL. Dos garantías que un doble en memoria no da:
 *  - lo que el cliente de pay-settlement ENVÍA se valida contra `internal-connectors-v1.yaml` (cuerpo del `POST /transfers`);
 *  - toda respuesta `contract` que el doble devuelve se valida contra el mismo contrato antes de enviarla (si el doble se aparta del
 *    contrato, la prueba falla en el doble, no en el cliente).
 * Las respuestas `raw`/`hang`/`cut` simulan lo que NO es del conector: el HTML de un proxy, un 502 vacío, un corte de socket.
 */
export class ConnectorsServer {
  readonly requests: Recorded[] = [];
  /** Respuestas `contract` que el doble habría enviado fuera del contrato. Tiene que quedar vacío: si no, la prueba no prueba lo que dice. */
  readonly violations: string[] = [];
  private readonly script = new Map<string, Behavior[]>();
  private readonly server: Server;
  private readonly sockets = new Set<ServerResponse>();
  url = '';

  constructor(
    private readonly contract: ContractValidator,
    /** Pasa de la ruta concreta a la plantilla del contrato (`/holds/hd_x/post` → `/holds/{id}/post`). */
    private readonly template: (path: string) => string = (path) => path.replace(/^\/transfers\/.+$/, '/transfers/{reference}'),
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.sockets) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Encola comportamientos para `METHOD /ruta` (el último se repite). */
  on(route: string, ...behaviors: Behavior[]): void {
    this.script.set(route, behaviors);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body });
    const route = `${req.method} ${this.template(url.pathname)}`;
    const queue = this.script.get(route);
    const behavior = queue && queue.length > 0 ? (queue.length > 1 ? (queue.shift() as Behavior) : queue[0]) : problem(404, 'resource_not_found');
    if (behavior.kind === 'hang') {
      this.sockets.add(res);
      return;
    }
    if (behavior.kind === 'cut') {
      req.socket.destroy();
      return;
    }
    if (behavior.kind === 'raw') {
      res.writeHead(behavior.status, behavior.contentType ? { 'content-type': behavior.contentType } : {});
      res.end(behavior.body);
      return;
    }
    const path = this.template(url.pathname);
    const errors = this.contract.validateResponse({ method: req.method ?? '', path, status: behavior.status, body: behavior.body });
    if (errors.length > 0) {
      this.violations.push(`${req.method} ${path} ${behavior.status}: ${errors.join('; ')}`);
      res.writeHead(599, { 'content-type': 'text/plain' });
      res.end(`EL DOBLE SE APARTA DEL CONTRATO: ${errors.join('; ')}`);
      return;
    }
    res.writeHead(behavior.status, { 'content-type': behavior.contentType ?? 'application/json' });
    res.end(JSON.stringify(behavior.body));
  }
}
