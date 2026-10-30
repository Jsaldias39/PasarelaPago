import type { LookupFunction } from 'node:net';
import { request } from 'node:https';
import type { ResolvedTarget } from './target-guard';

export interface TransportRequest {
  readonly target: ResolvedTarget;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Plazo DURO de pared de toda la entrega (conexión + TLS + respuesta): no se renueva con los bytes que llegan. */
  readonly timeoutMs: number;
  /** Tope de inactividad del socket; por defecto, el mismo plazo. */
  readonly idleTimeoutMs?: number;
}

export type TransportFailure = 'timeout' | 'connection_error' | 'tls_error';

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

const TLS_CODES = /^(ERR_TLS_|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_SSL_|HOSTNAME_MISMATCH)/;

/**
 * Entrega real por HTTPS a la IP que `TargetGuard` ya validó y fijó:
 * - conecta a `target.ip` (el nombre NO se vuelve a resolver) pero valida el certificado y envía SNI/Host con el nombre;
 * - NO sigue redirecciones: un 3xx se devuelve tal cual y la entrega lo cuenta como fallo;
 * - plazo DURO de pared (`timeoutMs`) desde que empieza, más un tope de inactividad: un receptor que gotea un byte cada tanto
 *   no puede mantener viva la entrega (el timeout de inactividad de Node se renueva con cada byte);
 * - NO lee la respuesta: en cuanto llegan el estado y las cabeceras se resuelve y se destruye el socket (el cuerpo del
 *   receptor no se usa; un cuerpo de 10 MB no se descarga);
 * - sin agente compartido ni reutilización de conexiones: cada entrega valida su propia IP.
 */
export class HttpsTransport implements DeliveryTransport {
  /** `ca` solo existe para que las pruebas confíen en un certificado propio; en producción va vacío (almacén del sistema). */
  constructor(private readonly options: { readonly ca?: string } = {}) {}

  send({ target, headers, body, timeoutMs, idleTimeoutMs }: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      // Plazo duro de pared: arranca ya, antes de conectar, y no se renueva con nada.
      const deadline = setTimeout(() => {
        req.destroy();
        done(() => reject(new TransportError('timeout')));
      }, timeoutMs);
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          servername: target.hostname,
          method: 'POST',
          path: target.path,
          agent: false,
          timeout: idleTimeoutMs ?? timeoutMs,
          ...(this.options.ca ? { ca: this.options.ca } : {}),
          // Fija la IP validada: la conexión va a `target.ip` aunque el DNS ahora diga otra cosa.
          lookup: pinnedLookup(target),
          headers: { ...headers, host: target.port === 443 ? target.hostname : `${target.hostname}:${target.port}`, 'content-length': String(Buffer.byteLength(body)) },
        },
        (res) => {
          // Solo importa el estado: se cierra la conexión sin leer el cuerpo.
          const status = res.statusCode ?? 0;
          done(() => resolve({ status }));
          res.destroy();
          req.destroy();
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
