import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

/**
 * [DOBLE DECLARADO] Colector OTLP/HTTP mínimo del arnés. Los servicios exportan sus trazas (si tienen `OTEL_EXPORTER_OTLP_ENDPOINT`) con el exportador
 * `http/protobuf` a `POST {endpoint}/v1/traces`; este colector guarda los cuerpos TAL CUAL llegan para que E7 pueda mirar si algún span lleva un PAN. No interpreta
 * protobuf: las cadenas de un mensaje protobuf viajan como bytes UTF-8 en claro, así que se leen como texto `latin1` (un byte = un carácter) y se buscan ahí.
 * No es Jaeger ni un colector real: responde 200 con cuerpo vacío (un `ExportTraceServiceResponse` vacío es válido) y descarta todo lo que no sea `POST /v1/traces`.
 */
export interface OtlpBody {
  readonly path: string;
  readonly contentType: string;
  /** Cuerpo descomprimido. */
  readonly body: Buffer;
}

export class OtlpSink {
  readonly bodies: OtlpBody[] = [];
  private server: Server | undefined;

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/traces') {
          res.writeHead(req.method === 'POST' ? 404 : 405).end();
          return;
        }
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') {
          try {
            body = gunzipSync(body);
          } catch {
            res.writeHead(400).end();
            return;
          }
        }
        this.bodies.push({ path: req.url, contentType: String(req.headers['content-type'] ?? ''), body });
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  /** Valor para `OTEL_EXPORTER_OTLP_ENDPOINT` (el exportador agrega `/v1/traces`). */
  get endpoint(): string {
    if (!this.server) throw new Error('el colector no está abierto');
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Todo lo recibido como un solo texto `latin1`, para buscar cadenas. */
  text(): string {
    return this.bodies.map((b) => b.body.toString('latin1')).join('\n');
  }

  /** ¿Algún cuerpo recibido menciona esta cadena? (p. ej. el `service.name` de un servicio). */
  mentions(needle: string): boolean {
    return this.bodies.some((b) => b.body.includes(needle));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
