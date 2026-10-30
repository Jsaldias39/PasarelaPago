import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpQrClient } from '../src/connectors/qr-http.client';

// [DOBLE] pay-qr: un servidor HTTP local que responde lo que el contrato propuesto promete (docs/trabajo/ola-1/P4/propuesta/internal-qr-v1.yaml).
// Lo que se prueba es el CLIENTE de pay-connectors: el servicio real pay-qr tiene su propia suite.
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let handler: Handler;
let baseUrl: string;
const seen: Array<{ headers: IncomingMessage['headers']; body: unknown; url: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: body ? JSON.parse(body) : null, url: req.url });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

const input = { chargeId: 'ch_aaaaaaaaaaaaaaaa', paymentIntentId: 'pi_aaaaaaaaaaaaaaaa', merchantId: 'mc_aaaaaaaaaaaaaaaa', payMode: 'test' as const, amountMinor: 12345n, expiresAt: new Date('2026-10-27T13:00:00Z') };
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

describe('HttpQrClient [DOBLE de pay-qr] — correcto, límite, inválido', () => {
  it('correcto: pide un QR dinámico con identidad de servicio y clave de idempotencia = id del cobro', async () => {
    handler = (_req, _body, res) => json(res, 201, { payload: '000201...6304ABCD', expires_at: '2026-10-27T12:59:00.000Z' });
    const result = await new HttpQrClient(baseUrl).issue(input);
    expect(result).toEqual({ payload: '000201...6304ABCD', expiresAt: new Date('2026-10-27T12:59:00.000Z') });
    expect(seen[0]?.url).toBe('/qr');
    expect(seen[0]?.headers['x-service-id']).toBe('pay-connectors');
    expect(seen[0]?.headers['x-pay-mode']).toBe('test'); // D-28: el modo de la clave viaja a pay-qr
    expect(seen[0]?.headers['idempotency-key']).toBe('qr-ch_aaaaaaaaaaaaaaaa');
    expect(seen[0]?.body).toMatchObject({ kind: 'dynamic', merchant_id: 'mc_aaaaaaaaaaaaaaaa', currency: 'BOB', amount_minor: 12345, payment_intent_id: 'pi_aaaaaaaaaaaaaaaa', expires_at: '2026-10-27T13:00:00.000Z' });
  });

  it('límite: 200 (repetición idempotente) y sin `expires_at` ⇒ usa el vencimiento pedido; la URL base admite barra final', async () => {
    handler = (_req, _body, res) => json(res, 200, { payload: 'P' });
    expect(await new HttpQrClient(`${baseUrl}/`).issue(input)).toEqual({ payload: 'P', expiresAt: input.expiresAt });
    expect(seen[0]?.url).toBe('/qr');
  });

  it('inválido: 5xx ⇒ no disponible (seguro de reintentar); 4xx ⇒ rechazado como error interno; sin payload ⇒ rechazado', async () => {
    const issue = () => new HttpQrClient(baseUrl).issue(input);
    handler = (_req, _body, res) => json(res, 503, {});
    await expect(issue()).rejects.toMatchObject({ name: 'ConnectorUnavailableError' });
    handler = (_req, _body, res) => json(res, 409, { code: 'invalid_state_transition' });
    await expect(issue()).rejects.toMatchObject({ name: 'ConnectorRejectedError', code: 'internal_error' });
    handler = (_req, _body, res) => json(res, 201, { expires_at: '2026-10-27T13:00:00Z' });
    await expect(issue()).rejects.toMatchObject({ name: 'ConnectorRejectedError', code: 'internal_error' });
    handler = (_req, _body, res) => json(res, 201, { payload: 42 });
    await expect(issue()).rejects.toMatchObject({ name: 'ConnectorRejectedError' });
  });

  it('inválido: sin respuesta a tiempo ⇒ timeout AMBIGUO; puerto cerrado ⇒ no disponible', async () => {
    handler = () => {
      /* no responde */
    };
    await expect(new HttpQrClient(baseUrl, 100).issue(input)).rejects.toMatchObject({ name: 'ConnectorTimeoutError' });
    await expect(new HttpQrClient('http://127.0.0.1:1').issue(input)).rejects.toMatchObject({ name: 'ConnectorUnavailableError' });
  });

  it('el mensaje de error nunca trae lo que respondió pay-qr', async () => {
    handler = (_req, _body, res) => json(res, 400, { detail: 'tarjeta 4111111111111111 de Juan Perez' });
    const error = await new HttpQrClient(baseUrl).issue(input).catch((e: Error) => e);
    expect(JSON.stringify([(error as Error).message, (error as Error).stack])).not.toMatch(/4111|Juan/);
  });

  it.each(['test', 'live'] as const)('propaga el modo de la clave (%s) en la llamada saliente, y jamás otro', async (mode) => {
    handler = (_req, _body, res) => json(res, 201, { payload: 'P' });
    await new HttpQrClient(baseUrl).issue({ ...input, payMode: mode });
    expect(seen[0]?.headers['x-pay-mode']).toBe(mode);
  });
});

