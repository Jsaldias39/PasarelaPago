import { createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookReceiver, type ReceiverOptions } from '../../src/receiver/webhook-receiver';
import type { TestCertificate } from '../tls';

/** Nombre con el que el servidor Svix (en Docker) alcanza al anfitrión: `extra_hosts: receptor.comercio.example:host-gateway` en platform/compose.yml. */
export const RECEIVER_HOST = 'receptor.comercio.example';

export interface CapturedRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Receptor HTTPS REAL del comercio para las pruebas contra Svix: escucha en todas las interfaces (Svix llega desde el contenedor) con un
 * certificado autofirmado y delega la verificación en `WebhookReceiver`, que usa `@pay/webhook-signature`. Además guarda las cabeceras y el
 * cuerpo crudos de cada petición para que la prueba verifique la firma por su cuenta (p. ej. con solo el secreto viejo).
 */
export class HttpsReceiver {
  readonly receiver: WebhookReceiver;
  /** Todo lo que llegó, en orden. */
  readonly requests: CapturedRequest[] = [];
  /** Lo que el comercio guardó al crear el endpoint (y al rotarlo): se agrega a estos arreglos y el receptor ya verifica con ello. */
  readonly secrets: string[] = [];
  readonly publicKeys: string[] = [];
  private server: Server | undefined;
  port = 0;

  constructor(options: Pick<ReceiverOptions, 'override' | 'toleranceSeconds'>, private readonly certificate: TestCertificate) {
    this.receiver = new WebhookReceiver({ ...options, secrets: this.secrets, publicKeys: this.publicKeys });
  }

  get url(): string {
    return `https://${RECEIVER_HOST}:${this.port}/hook`;
  }

  async listen(): Promise<this> {
    this.server = createServer({ cert: this.certificate.cert, key: this.certificate.key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({ headers: req.headers, body });
        res.writeHead(this.receiver.process(req.headers, body)).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
