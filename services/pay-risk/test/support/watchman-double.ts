import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * [DOBLE] de moov Watchman para los fallos que el Watchman real no produce a pedido: errores 5xx, JSON roto, forma inesperada,
 * demoras y puntajes fuera de rango. NO es Watchman: las pruebas de coincidencia usan el real (54084).
 * Registra cada petición recibida para comprobar QUÉ se le manda (solo nombre y tipo).
 */
export type Behavior = (req: IncomingMessage, res: ServerResponse, type: string | null) => void;

export interface WatchmanDouble {
  url: string;
  requests: { path: string; params: Record<string, string> }[];
  behavior: Behavior;
  close(): Promise<void>;
}

export const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const entity = (match: number, over: Record<string, unknown> = {}) => ({ name: 'ENTRADA PUBLICA DE PRUEBA', entityType: 'business', sourceList: 'us_ofac', sourceID: '4697', match, ...over });

export async function startWatchmanDouble(initial: Behavior): Promise<WatchmanDouble> {
  const double: WatchmanDouble = { url: '', requests: [], behavior: initial, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    double.requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    double.behavior(req, res, url.searchParams.get('type'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  double.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  double.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return double;
}
