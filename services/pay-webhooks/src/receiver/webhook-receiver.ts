import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verify, WebhookVerificationError } from '@pay/webhook-signature';

export interface ReceivedEvent {
  readonly webhookId: string;
  readonly timestamp: number;
  readonly body: string;
}

/** Una petición que llegó al receptor, aceptada o no. */
export interface ReceiverLogEntry {
  readonly webhookId: string | undefined;
  readonly status: number;
  /** `ok`, `duplicate`, `overridden` o el motivo de rechazo de la verificación. */
  readonly outcome: string;
}

export interface ReceiverOptions {
  /** Secretos simétricos `whsec_…` que el comercio guardó al crear el endpoint. */
  readonly secrets?: readonly string[];
  /** Claves públicas `whpk_…` (esquema v1a). */
  readonly publicKeys?: readonly string[];
  readonly toleranceSeconds?: number;
  /** Segundos desde la época; solo para pruebas. */
  readonly now?: () => number;
  /** Forzar una respuesta antes de verificar (simula un endpoint caído o que devuelve 410). `undefined` = comportamiento normal. */
  readonly override?: (request: { webhookId: string | undefined; seen: number }) => number | undefined;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Receptor de webhooks que verifica la firma Standard Webhooks: sirve para E6 y de ejemplo para los comercios.
 * Una firma alterada, un cuerpo cambiado o una marca de tiempo vieja dan 400 y NO se aceptan; un `webhook-id` repetido da 200
 * pero se cuenta una sola vez (el receptor es idempotente, como debe ser el de un comercio).
 */
export class WebhookReceiver {
  /** Eventos aceptados, uno por `webhook-id`. */
  readonly accepted: ReceivedEvent[] = [];
  /** Todo lo que llegó, en orden. */
  readonly log: ReceiverLogEntry[] = [];
  private server: Server | undefined;

  constructor(private readonly options: ReceiverOptions) {}

  /** Procesa una petición ya leída. Devuelve el estado HTTP que hay que responder. */
  process(headers: Record<string, string | string[] | undefined>, body: string): number {
    const raw = headers['webhook-id'];
    const webhookId = Array.isArray(raw) ? raw[0] : raw;
    const seen = webhookId ? this.arrivals(webhookId) : 0;

    const forced = this.options.override?.({ webhookId, seen });
    if (forced !== undefined) return this.record(webhookId, forced, 'overridden');

    try {
      verify({
        headers,
        payload: body,
        ...(this.options.secrets ? { secrets: this.options.secrets } : {}),
        ...(this.options.publicKeys ? { publicKeys: this.options.publicKeys } : {}),
        ...(this.options.toleranceSeconds !== undefined ? { toleranceSeconds: this.options.toleranceSeconds } : {}),
        ...(this.options.now ? { now: this.options.now() } : {}),
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) return this.record(webhookId, 400, error.reason);
      throw error;
    }
    if (webhookId === undefined) return this.record(webhookId, 400, 'missing_headers');
    if (this.accepted.some((event) => event.webhookId === webhookId)) return this.record(webhookId, 200, 'duplicate');
    this.accepted.push({ webhookId, timestamp: Number(headers['webhook-timestamp']), body });
    return this.record(webhookId, 200, 'ok');
  }

  private record(webhookId: string | undefined, status: number, outcome: string): number {
    this.log.push({ webhookId, status, outcome });
    return status;
  }

  /** Cuántas veces llegó un `webhook-id` (cualquier resultado). */
  arrivals(webhookId: string): number {
    return this.log.filter((entry) => entry.webhookId === webhookId).length;
  }

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    res.writeHead(this.process(req.headers, Buffer.concat(chunks).toString('utf8'))).end();
  }
}
