import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { verify, WebhookVerificationError } from '@pay/webhook-signature';

export interface ReceiverEntry {
  readonly path: string;
  readonly webhookId: string | undefined;
  readonly status: number;
  /** `ok`, `duplicate`, `down`, `gone` o el motivo por el que la firma no verificó. */
  readonly outcome: string;
  readonly body?: string;
}

export interface ReceiverRoute {
  readonly secret: string;
  /** `up`: verifica y responde 200 · `down`: responde 500 sin verificar (endpoint caído) · `gone`: responde 410. */
  mode: 'up' | 'down' | 'gone';
}

/**
 * Receptor HTTPS del comercio (para E6 y como ejemplo): verifica la firma Standard Webhooks con el secreto de la ruta y registra
 * cada petición. Es un servidor real con el certificado autofirmado que `pay-webhooks` acepta SOLO en sandbox.
 */
export class MerchantReceiver {
  readonly log: ReceiverEntry[] = [];
  readonly accepted = new Map<string, { path: string; body: string; attempts: number }>();
  private server: Server | undefined;
  private readonly routes = new Map<string, ReceiverRoute>();

  constructor(
    private readonly options: { port: number; certFile: string; keyFile: string },
  ) {}

  route(path: string, route: ReceiverRoute): ReceiverRoute {
    this.routes.set(path, route);
    return route;
  }

  async listen(): Promise<void> {
    this.server = createServer({ cert: readFileSync(this.options.certFile), key: readFileSync(this.options.keyFile) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0];
        const body = Buffer.concat(chunks).toString('utf8');
        const webhookId = typeof req.headers['webhook-id'] === 'string' ? req.headers['webhook-id'] : undefined;
        const route = this.routes.get(path);
        const answer = (status: number, outcome: string) => {
          this.log.push({ path, webhookId, status, outcome });
          res.writeHead(status).end();
        };
        if (!route) return answer(404, 'ruta desconocida');
        if (route.mode === 'down') return answer(500, 'down');
        if (route.mode === 'gone') return answer(410, 'gone');
        try {
          verify({ headers: req.headers, payload: body, secrets: [route.secret] });
        } catch (error) {
          return answer(400, error instanceof WebhookVerificationError ? error.reason : 'error');
        }
        if (!webhookId) return answer(400, 'missing_headers');
        const previous = this.accepted.get(webhookId);
        if (previous) {
          previous.attempts += 1;
          return answer(200, 'duplicate');
        }
        this.accepted.set(webhookId, { path, body, attempts: 1 });
        answer(200, 'ok');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  arrivals(path: string): ReceiverEntry[] {
    return this.log.filter((entry) => entry.path === path);
  }
}

