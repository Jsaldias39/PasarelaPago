import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * [DOBLE DECLARADO] Proxy de fallos entre `pay-connectors` y `pay-mockbank`. NO es un banco ni es un servicio del producto: es una pieza del arnés.
 *
 * Existe porque `pay-mockbank` solo sabe fallar de forma DEFINITIVA con los reembolsos (`503 bank_unavailable`, sin efecto): el escenario por centavos
 * es de cobros y transferencias. Un reembolso AMBIGUO (la orden SE EJECUTÓ en el banco y la respuesta se pierde, regla 11 del CLAUDE.md) no se puede
 * pedir al banco, así que se produce en el cable: el proxy REENVÍA la orden al banco real, espera su respuesta y entonces CORTA la conexión del cliente
 * sin contestarle. Desde `pay-connectors` es indistinguible de un corte de red después de que el banco ejecutó.
 *
 * Modos: `pass` (reenvía todo tal cual) y `cut_after_execute` (solo las peticiones que cumplen `cutWhen`; las demás pasan). Lleva un registro de lo que
 * vio para que las pruebas cuenten intentos y comprueben que todos usaron la misma referencia.
 */
export type ProxyMode = 'pass' | 'cut_after_execute';

export interface ProxyRecord {
  readonly method: string;
  readonly path: string;
  /** Campo `reference` del cuerpo JSON (el `cr_…` del reembolso, la referencia del cobro…); `null` si no hay. */
  readonly reference: string | null;
  /** Estado con que respondió el banco; `null` si el banco no respondió. */
  readonly upstreamStatus: number | null;
  /** `forwarded`: se devolvió la respuesta del banco · `cut`: el banco ejecutó y se cortó al cliente · `refused`: no se pudo hablar con el banco (o no hay destino) y se cortó. */
  readonly action: 'forwarded' | 'cut' | 'refused';
}

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'proxy-connection']);

export class BankFaultProxy {
  mode: ProxyMode = 'pass';
  readonly records: ProxyRecord[] = [];
  private target: string | undefined;
  private server: Server | undefined;
  private readonly cutWhen: (method: string, path: string) => boolean;

  constructor(options: { cutWhen?: (method: string, path: string) => boolean } = {}) {
    this.cutWhen = options.cutWhen ?? ((method, path) => method === 'POST' && path === '/sandbox/refunds');
  }

  /** Abre el proxy en un puerto libre de 127.0.0.1. */
  async listen(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  get url(): string {
    if (!this.server) throw new Error('el proxy no está abierto');
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Adónde reenvía (la URL del `pay-mockbank` real, que solo se conoce al arrancar el stack). Sin destino el proxy corta la conexión. */
  setTarget(url: string | undefined): void {
    this.target = url?.replace(/\/$/, '');
  }

  recordsOf(method: string, path: string): ProxyRecord[] {
    return this.records.filter((r) => r.method === method && r.path === path);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const reference = referenceOf(body);
    if (!this.target) {
      this.records.push({ method, path, reference, upstreamStatus: null, action: 'refused' });
      req.socket.destroy();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name) && typeof value === 'string') headers[name] = value;
    let upstream: Response;
    let payload: Buffer;
    try {
      upstream = await fetch(`${this.target}${path}`, { method, headers, ...(body.length > 0 && method !== 'GET' && method !== 'HEAD' ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      payload = Buffer.from(await upstream.arrayBuffer());
    } catch {
      this.records.push({ method, path, reference, upstreamStatus: null, action: 'refused' });
      req.socket.destroy();
      return;
    }
    if (this.mode === 'cut_after_execute' && this.cutWhen(method, path)) {
      this.records.push({ method, path, reference, upstreamStatus: upstream.status, action: 'cut' });
      req.socket.destroy(); // el banco YA ejecutó: el cliente no recibe nada
      return;
    }
    this.records.push({ method, path, reference, upstreamStatus: upstream.status, action: 'forwarded' });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name)) out[name] = value;
    });
    out['content-length'] = String(payload.length);
    res.writeHead(upstream.status, out);
    res.end(payload);
  }
}

function referenceOf(body: Buffer): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { reference?: unknown };
    return typeof parsed.reference === 'string' ? parsed.reference : null;
  } catch {
    return null;
  }
}
