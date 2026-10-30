import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SvixApiError, SvixClient, SvixUnavailableError } from '../../src/engine/svix/svix-client';

/** Cliente REST de Svix contra un `fetch` programable (sin red): qué se reintenta, qué no, y que el token y los cuerpos no se filtren. */
const TOKEN = 'cabecera.carga.firma-secreta-del-token';
const respond = (status: number, body: unknown = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(script: (call: number, url: URL, init: RequestInit) => Response | Error, maxAttempts = 3) {
  const sleeps: number[] = [];
  const seen: { method: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ method: String(init?.method), url: new URL(String(input)), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), headers: init?.headers as Record<string, string> });
    const result = script(seen.length, new URL(String(input)), init ?? {});
    if (!(result instanceof Response)) throw result;
    return result;
  };
  const client = new SvixClient({ baseUrl: 'http://svix.test:8071/', authToken: TOKEN, timeoutMs: 1000, maxAttempts, fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  return { client, seen, sleeps };
}

describe('SvixClient', () => {
  it('CORRECTO: autentica con Bearer, apunta a /api/v1, manda el cuerpo y no sigue redirecciones', async () => {
    const { client, seen } = clientWith(() => respond(202, { id: 'msg_1' }));
    await expect(client.createMessage('mc_a', { eventId: 'e1', eventType: 'payout.paid', payload: { id: 'e1' } })).resolves.toBe('created');
    expect(seen[0]).toMatchObject({ method: 'POST', body: { eventId: 'e1', eventType: 'payout.paid', payload: { id: 'e1' } } });
    expect(seen[0].url.href).toBe('http://svix.test:8071/api/v1/app/mc_a/msg');
    expect(seen[0].headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
  });

  it('el 409 de un mensaje es «ya existe», no un error', async () => {
    const { client } = clientWith(() => respond(409, { code: 'conflict', detail: 'A conflict has occurred' }));
    await expect(client.createMessage('mc_a', { eventId: 'e1', eventType: 't', payload: {} })).resolves.toBe('exists');
  });

  it.each([[500], [502], [503], [504], [429]])('AMBIGUO: un %i se reintenta con la MISMA petición y, si sigue, sube como SvixUnavailableError', async (status) => {
    const { client, seen, sleeps } = clientWith(() => respond(status));
    await expect(client.createMessage('mc_a', { eventId: 'e1', eventType: 't', payload: {} })).rejects.toMatchObject({ name: 'SvixUnavailableError', status });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((c) => JSON.stringify(c.body))).size).toBe(1); // mismo eventId, mismo cuerpo
    expect(sleeps).toEqual([200, 400]); // espera creciente
  });

  it('AMBIGUO: un corte de red o un timeout se reintenta y una respuesta posterior lo resuelve', async () => {
    const { client, seen } = clientWith((call) => (call === 1 ? new TypeError('fetch failed') : call === 2 ? new DOMException('x', 'TimeoutError') : respond(202)));
    await expect(client.createMessage('mc_a', { eventId: 'e1', eventType: 't', payload: {} })).resolves.toBe('created');
    expect(seen).toHaveLength(3);
  });

  it.each([['timeout', new DOMException('x', 'TimeoutError')], ['network', new TypeError('fetch failed')]])('AMBIGUO: agotados los intentos por %s sube SvixUnavailableError(%s)', async (reason, error) => {
    const { client } = clientWith(() => error as Error, 2);
    await expect(client.ensureApp('mc_a', 'mc_a')).rejects.toMatchObject({ name: 'SvixUnavailableError', reason });
  });

  it.each([[400], [401], [403], [404], [422]])('DEFINITIVO: un %i NO se reintenta y sube como SvixApiError', async (status) => {
    const { client, seen } = clientWith(() => respond(status, status === 422 ? { detail: [{ loc: ['body', 'payload'], msg: 'Payload must be an object.' }] } : { code: 'not_found', detail: 'x' }));
    const error = await client.ensureApp('mc_a', 'mc_a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SvixApiError);
    expect(seen).toHaveLength(1);
    expect((error as SvixApiError).status).toBe(status);
    expect((error as SvixApiError).code).toBe(status === 422 ? 'validation' : 'not_found');
  });

  it('un 2xx distinto del esperado no se da por bueno', async () => {
    const { client } = clientWith(() => respond(200, {}));
    await expect(client.createMessage('mc_a', { eventId: 'e1', eventType: 't', payload: {} })).rejects.toMatchObject({ name: 'SvixApiError', status: 200 });
  });

  it('el token, el cuerpo enviado y el texto del servidor NO aparecen en los errores', async () => {
    const { client } = clientWith(() => respond(422, { detail: [{ msg: 'secreto-que-no-debe-salir whsec_ZZZ' }] }));
    const error = await client.createEndpoint('mc_a', { uid: 'we_x', url: 'https://x.example/ruta-con-token-abc', eventTypes: null, secret: 'whsec_SECRETO_DE_FIRMA' }).catch((e: unknown) => e);
    const text = `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`;
    for (const leak of [TOKEN, 'whsec_SECRETO_DE_FIRMA', 'ruta-con-token-abc', 'secreto-que-no-debe-salir']) expect(text).not.toContain(leak);
  });

  it('un cuerpo de error cuyo `code` no tiene la forma esperada no se copia al error', async () => {
    const { client } = clientWith(() => respond(409, { code: 'Texto <libre> con espacios', detail: 'x' }));
    const error = await client.ensureApp('mc_a', 'mc_a').catch((e: unknown) => e);
    expect((error as SvixApiError).code).toBe('http_409');
  });

  it('rotateSecret NO reintenta por su cuenta (lo hace el motor, mirando la clave antes)', async () => {
    const { client, seen } = clientWith(() => respond(503));
    await expect(client.rotateSecret('mc_a', 'we_x', 'whsec_nueva', 60)).rejects.toBeInstanceOf(SvixUnavailableError);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ key: 'whsec_nueva', gracePeriodSeconds: 60 });
  });

  it('los identificadores de la ruta se codifican (un uid con «/» o «?» no cambia el destino)', async () => {
    const { client, seen } = clientWith(() => respond(200, { key: 'k' }));
    await client.getEndpointKey('mc_a/../x', 'we_?y');
    expect(seen[0].url.pathname).toBe('/api/v1/app/mc_a%2F..%2Fx/endpoint/we_%3Fy/secret');
    expect(seen[0].url.search).toBe('');
  });

  it('listEndpoints recorre todas las páginas y devuelve undefined si la aplicación no existe', async () => {
    const page = (n: number, done: boolean) => respond(200, { data: [{ id: `ep_${n}`, uid: `we_${n}`, url: 'https://x.example', disabled: false, createdAt: '2026-10-30T00:00:00Z', eventTypes: null }], iterator: `it_${n}`, done });
    const { client, seen } = clientWith((call) => (call === 1 ? page(1, false) : page(2, true)));
    expect((await client.listEndpoints('mc_a'))?.map((e) => e.uid)).toEqual(['we_1', 'we_2']);
    expect(seen[1].url.searchParams.get('iterator')).toBe('it_1');
    const missing = clientWith(() => respond(404, { code: 'not_found', detail: 'x' }));
    await expect(missing.client.listEndpoints('mc_zzz')).resolves.toBeUndefined();
  });

  it('deleteEndpoint trata el 404 como «ya no está» y getMessage como «no hay»; ningún otro 4xx se disimula', async () => {
    const notFound = clientWith(() => respond(404, { code: 'not_found', detail: 'x' }));
    await expect(notFound.client.deleteEndpoint('mc_a', 'we_x')).resolves.toBeUndefined();
    await expect(notFound.client.getMessage('mc_a', 'e1')).resolves.toBeUndefined();
    const denied = clientWith(() => respond(403, { code: 'forbidden', detail: 'x' }));
    await expect(denied.client.deleteEndpoint('mc_a', 'we_x')).rejects.toMatchObject({ status: 403 });
  });

  it('AMBIGUO [servidor REAL que no contesta]: el plazo se corta (AbortSignal.timeout), se reintenta y sube como timeout', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(() => undefined); // acepta la conexión y nunca responde
    server.on('connection', (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new SvixClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, authToken: TOKEN, timeoutMs: 150, maxAttempts: 2, sleep: async () => undefined });
      const started = Date.now();
      await expect(client.ensureApp('mc_a', 'mc_a')).rejects.toMatchObject({ name: 'SvixUnavailableError', reason: 'timeout' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(280); // dos intentos de 150 ms
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
