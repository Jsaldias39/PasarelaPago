import type { LookupFunction } from 'node:net';
import { request } from 'node:https';
import type { ResolvedTarget } from './target-guard';

export interface TransportRequest {
  readonly target: ResolvedTarget;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export type TransportFailure = 'timeout' | 'connection_error' | 'tls_error' | 'response_too_large';

/** Falla de red: `reason` es un código estable; el mensaje del sistema (que puede traer IPs internas) no se conserva. */
export class TransportError extends Error {
  constructor(readonly reason: TransportFailure) {
    super(`Entrega fallida: ${reason}`);
    this.name = 'TransportError';
  }
}

export interface TransportResponse {
  readonly status: number;
}

/** Lo único que la entrega necesita de la red; los dobles de prueba lo implementan. */
export interface DeliveryTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** `lookup` que ignora el nombre y devuelve siempre la IP ya validada (Node pide una sola o todas, según `autoSelectFamily`). */
function pinnedLookup(target: ResolvedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: target.ip, family: target.family }]);
    else callback(null, target.ip, target.family);
  };
}

const MAX_RESPONSE_BYTES = 16 * 1024;
const TLS_CODES = /^(ERR_TLS_|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_SSL_|HOSTNAME_MISMATCH)/;

/**
 * Entrega real por HTTPS a la IP que `TargetGuard` ya validó y fijó:
 * - conecta a `target.ip` (el nombre NO se vuelve a resolver) pero valida el certificado y envía SNI/Host con el nombre;
 * - NO sigue redirecciones: un 3xx se devuelve tal cual y la entrega lo cuenta como fallo;
 * - tiempo máximo total y tope de la respuesta (el cuerpo de la respuesta no se guarda ni se registra);
 * - sin agente compartido ni reutilización de conexiones: cada entrega valida su propia IP.
 */
export class HttpsTransport implements DeliveryTransport {
  /** `ca` solo existe para que las pruebas confíen en un certificado propio; en producción va vacío (almacén del sistema). */
  constructor(private readonly options: { readonly ca?: string } = {}) {}

  send({ target, headers, body, timeoutMs }: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          servername: target.hostname,
          method: 'POST',
          path: target.path,
          agent: false,
          timeout: timeoutMs,
          ...(this.options.ca ? { ca: this.options.ca } : {}),
          // Fija la IP validada: la conexión va a `target.ip` aunque el DNS ahora diga otra cosa.
          lookup: pinnedLookup(target),
          headers: { ...headers, host: target.port === 443 ? target.hostname : `${target.hostname}:${target.port}`, 'content-length': String(Buffer.byteLength(body)) },
        },
        (res) => {
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              res.destroy();
              done(() => reject(new TransportError('response_too_large')));
            }
          });
          res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0 })));
          res.on('error', () => done(() => reject(new TransportError('connection_error'))));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(() => reject(new TransportError('timeout')));
      });
      req.on('error', (error: NodeJS.ErrnoException) => done(() => reject(new TransportError(error.code && TLS_CODES.test(error.code) ? 'tls_error' : 'connection_error'))));
      req.end(body);
    });
  }
}
