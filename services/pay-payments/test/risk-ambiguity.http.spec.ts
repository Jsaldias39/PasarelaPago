import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CircuitBreaker, HttpClient, UpstreamError } from '../src/clients/http';

/**
 * Ola 5 · P3 · REVISION-DINERO F1 y F3 (CLAUDE.md regla 11: un resultado ambiguo —timeout, corte, 5xx— NO prueba que la orden no se ejecutó).
 *
 * `HttpClient.request` reintenta DENTRO de un mismo intento de la actividad y antes lanzaba solo el ÚLTIMO error: un timeout (la primera llamada llegó a pay-risk
 * y la evaluación sigue viva) seguido de un 503 llegaba a `assessRisk` como un 5xx «puro». Ahora cada `UpstreamError` dice si SE PRUEBA que la llamada no llegó
 * (`provenNotReached`) y si una llamada anterior del mismo `request()` pudo llegar (`earlierAttemptMayHaveReached`).
 * Solo se prueba «no llegó» ante: conexión rechazada, DNS que no resuelve, red inalcanzable y breaker abierto. Todo lo demás (timeout, corte de socket, 5xx,
 * 4xx sin el cuerpo del contrato, 2xx ilegible) es AMBIGUO.
 * Tres niveles por pieza (regla 65): correcto, límite e inválido. Servidores HTTP reales en 127.0.0.1; sin base ni Temporal.
 */
const URL_OF = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const listen = async (handler: (req: IncomingMessage, res: ServerResponse, n: number) => void): Promise<{ server: Server; url: string; close: () => Promise<void> }> => {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    n += 1;
    handler(req, res, n);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: URL_OF(server), close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
};
const closedPort = async (): Promise<string> => {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const url = URL_OF(s);
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return url;
};
const client = (baseUrl: string, extra: { timeoutMs?: number; failureThreshold?: number; ignoreTimeouts?: boolean; retries?: number } = {}) =>
  new HttpClient({ name: 'pay-risk', baseUrl, serviceId: 'pay-payments', timeoutMs: extra.timeoutMs ?? 120, retries: extra.retries ?? 1, breaker: { failureThreshold: extra.failureThreshold ?? 1000, resetAfterMs: 60_000, ...(extra.ignoreTimeouts ? { ignoreTimeouts: true } : {}) } });
const post = (c: HttpClient) => c.request({ method: 'POST', path: '/assessments', body: { x: 1 }, idempotencyKey: 'k-0001-aaaa' });
const failure = async (c: HttpClient): Promise<UpstreamError> => {
  try {
    await post(c);
  } catch (error) {
    return error as UpstreamError;
  }
  throw new Error('se esperaba un UpstreamError');
};
const problem = (res: ServerResponse, status: number, code: string) => res.writeHead(status, { 'content-type': 'application/problem+json', connection: 'close' }).end(JSON.stringify({ code, status }));

describe('HttpClient · qué se PRUEBA de una llamada que falla (F1)', () => {
  describe('correcto · solo lo que de verdad no llegó se declara «no llegó»', () => {
    it('conexión rechazada en las dos pasadas ⇒ provenNotReached, sin llamada anterior ambigua', async () => {
      const error = await failure(client(await closedPort()));
      expect(error).toMatchObject({ kind: 'network', provenNotReached: true, earlierAttemptMayHaveReached: false });
    });

    it('breaker abierto desde antes ⇒ circuit_open provenNotReached (ninguna llamada de este request salió)', async () => {
      const server = await listen((_req, res) => problem(res, 503, 'x'));
      try {
        const c = client(server.url, { failureThreshold: 1 });
        await expect(c.breaker.exec(async () => { throw new UpstreamError('server_error', 'pay-risk', 503); })).rejects.toBeDefined();
        expect(await failure(c)).toMatchObject({ kind: 'circuit_open', provenNotReached: true, earlierAttemptMayHaveReached: false });
        expect(server.server.listening).toBe(true);
      } finally {
        await server.close();
      }
    });

    it.each([['ECONNREFUSED'], ['ENOTFOUND'], ['EAI_AGAIN'], ['EHOSTUNREACH'], ['ENETUNREACH']])('%s (la conexión no se estableció) ⇒ provenNotReached', async (code) => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) }); }) as typeof fetch;
      try {
        expect(await failure(client('http://pay-risk.test'))).toMatchObject({ kind: 'network', provenNotReached: true });
      } finally {
        globalThis.fetch = original;
      }
    });

    it('happy eyeballs (AggregateError con TODAS las direcciones rechazadas) ⇒ provenNotReached', async () => {
      const original = globalThis.fetch;
      const aggregate = Object.assign(new Error('connect'), { errors: [Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })] });
      globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: aggregate }); }) as typeof fetch;
      try {
        expect(await failure(client('http://pay-risk.test'))).toMatchObject({ provenNotReached: true });
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe('límite · una llamada anterior del MISMO request pudo llegar: el último error no la borra', () => {
    it('timeout (la evaluación sigue viva) y luego 503 en el mismo intento ⇒ el 503 informa earlierAttemptMayHaveReached', async () => {
      const server = await listen((_req, res, n) => (n === 1 ? undefined : problem(res, 503, 'risk_unavailable')));
      try {
        const error = await failure(client(server.url));
        expect(error).toMatchObject({ kind: 'server_error', status: 503, provenNotReached: false, earlierAttemptMayHaveReached: true });
      } finally {
        await server.close();
      }
    });

    it('timeout y luego conexión rechazada ⇒ la conexión rechazada NO prueba nada: la primera pudo llegar', async () => {
      let closing: Promise<void> | undefined;
      const server = await listen((_req, _res, n) => {
        if (n === 1) closing = new Promise<void>((resolve) => server.server.close(() => resolve())); // deja de aceptar: el reintento se rechaza
      });
      try {
        const error = await failure(client(server.url));
        expect(error).toMatchObject({ kind: 'network', provenNotReached: false, earlierAttemptMayHaveReached: true });
      } finally {
        server.server.closeAllConnections();
        await closing;
      }
    });

    it('timeout y luego breaker abierto (lo abrió otra llamada mientras esperaba) ⇒ circuit_open informa earlierAttemptMayHaveReached', async () => {
      const server = await listen(() => undefined); // nunca responde
      try {
        const c = client(server.url, { failureThreshold: 1, timeoutMs: 150 });
        const pending = failure(c);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await expect(c.breaker.exec(async () => { throw new UpstreamError('server_error', 'pay-risk', 503); })).rejects.toBeDefined(); // otra llamada lo abre
        expect(await pending).toMatchObject({ kind: 'circuit_open', provenNotReached: false, earlierAttemptMayHaveReached: true });
      } finally {
        await server.close();
      }
    });

    it('la marca se conserva con 3 pasadas: timeout, 503 y conexión rechazada ⇒ ambiguo', async () => {
      let closing: Promise<void> | undefined;
      const server = await listen((_req, res, n) => {
        if (n === 2) {
          problem(res, 503, 'risk_unavailable');
          closing = new Promise<void>((resolve) => server.server.close(() => resolve()));
        }
      });
      try {
        const error = await failure(client(server.url, { retries: 2 }));
        expect(error).toMatchObject({ kind: 'network', provenNotReached: false, earlierAttemptMayHaveReached: true });
      } finally {
        server.server.closeAllConnections();
        await closing;
      }
    });
  });

  describe('inválido · nada de esto prueba que la orden no se ejecutó', () => {
    it('5xx (con y sin cuerpo del contrato) ⇒ ambiguo', async () => {
      const server = await listen((_req, res) => problem(res, 503, 'risk_unavailable'));
      try {
        expect(await failure(client(server.url))).toMatchObject({ kind: 'server_error', provenNotReached: false });
      } finally {
        await server.close();
      }
      const plain = await listen((_req, res) => res.writeHead(502).end('<html>bad gateway</html>'));
      try {
        expect(await failure(client(plain.url))).toMatchObject({ kind: 'server_error', provenNotReached: false });
      } finally {
        await plain.close();
      }
    });

    it('4xx SIN el cuerpo de error del contrato (un proxy, un service-auth mal puesto) y 2xx ilegible ⇒ unexpected_response, ambiguo', async () => {
      const forbidden = await listen((_req, res) => res.writeHead(403).end());
      try {
        expect(await failure(client(forbidden.url))).toMatchObject({ kind: 'unexpected_response', status: 403, provenNotReached: false });
      } finally {
        await forbidden.close();
      }
      const garbled = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{no es json'));
      try {
        expect(await failure(client(garbled.url))).toMatchObject({ kind: 'unexpected_response', provenNotReached: false });
      } finally {
        await garbled.close();
      }
    });

    it('corte de socket tras aceptar la conexión (la orden pudo enviarse) ⇒ network AMBIGUO, no «no llegó»', async () => {
      const server = await listen((req) => req.socket.destroy());
      try {
        expect(await failure(client(server.url))).toMatchObject({ kind: 'network', provenNotReached: false });
      } finally {
        await server.close();
      }
    });

    it.each([['ECONNRESET'], ['UND_ERR_SOCKET'], ['EPIPE'], [undefined]])('error de red con causa %s (o sin causa) ⇒ ambiguo', async (code) => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), code ? { cause: Object.assign(new Error('x'), { code }) } : {}); }) as typeof fetch;
      try {
        expect(await failure(client('http://pay-risk.test'))).toMatchObject({ kind: 'network', provenNotReached: false });
      } finally {
        globalThis.fetch = original;
      }
    });

    it('un AggregateError con UNA dirección que no es «rechazada» ⇒ ambiguo', async () => {
      const original = globalThis.fetch;
      const aggregate = Object.assign(new Error('connect'), { errors: [Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNRESET' })] });
      globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: aggregate }); }) as typeof fetch;
      try {
        expect(await failure(client('http://pay-risk.test'))).toMatchObject({ provenNotReached: false });
      } finally {
        globalThis.fetch = original;
      }
    });

    it('control · una respuesta de negocio (409 con code) NO es un UpstreamError: se devuelve tal cual', async () => {
      const server = await listen((_req, res) => problem(res, 409, 'idempotency_request_in_progress'));
      try {
        await expect(post(client(server.url))).resolves.toMatchObject({ status: 409, body: { code: 'idempotency_request_in_progress' } });
      } finally {
        await server.close();
      }
    });
  });
});

describe('CircuitBreaker · una sonda semiabierta que vence por timeout no deja el breaker pegado (F3)', () => {
  const OPTIONS = { failureThreshold: 2, resetAfterMs: 1000 };
  const fail5xx = () => { throw new UpstreamError('server_error', 'pay-risk', 503); };
  const timeout = () => { throw new UpstreamError('timeout', 'pay-risk'); };
  /** Breaker abierto por dos 5xx y con el reloj ya pasado el reset: está semiabierto. */
  const halfOpen = async (extra: { ignoreTimeouts?: boolean } = {}) => {
    const clock = { t: 1_000_000 };
    const breaker = new CircuitBreaker('pay-risk', { ...OPTIONS, ...extra, now: () => clock.t });
    for (let i = 0; i < 2; i += 1) await expect(breaker.exec(async () => fail5xx())).rejects.toBeDefined();
    expect(breaker.state).toBe('open');
    clock.t += 1500;
    expect(breaker.state).toBe('half_open');
    return { breaker, clock };
  };
  const deferred = () => {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('correcto · una sonda que sale bien cierra el breaker (sin cambio)', async () => {
    const { breaker } = await halfOpen({ ignoreTimeouts: true });
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('límite · DURANTE la sonda las demás llamadas reciben circuit_open (una sola sonda); si la sonda VENCE por timeout, las siguientes llegan a la dependencia en vez de recibir circuit_open', async () => {
    const { breaker } = await halfOpen({ ignoreTimeouts: true });
    const probe = deferred();
    const probing = breaker.exec(() => probe.promise);
    await expect(breaker.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' }); // mientras la sonda sigue en vuelo
    probe.reject(new UpstreamError('timeout', 'pay-risk'));
    await expect(probing).rejects.toMatchObject({ kind: 'timeout' });
    expect(breaker.state).toBe('half_open'); // un timeout no cierra ni reabre: no es concluyente

    const ran: number[] = [];
    const slow = [1, 2, 3].map((n) => ({ n, d: deferred() }));
    const calls = slow.map(({ n, d }) => breaker.exec(() => { ran.push(n); return d.promise; }).catch((e: UpstreamError) => e.kind));
    expect(ran).toEqual([1, 2, 3]); // las TRES llegaron a la dependencia: ninguna recibió circuit_open sin salir
    for (const { d } of slow) d.resolve('ok');
    expect(await Promise.all(calls)).toEqual(['ok', 'ok', 'ok']);
    expect(breaker.state).toBe('closed');
  });

  it('límite · tras una sonda vencida, una falla REAL (5xx) reabre el breaker enseguida y vuelve la única sonda', async () => {
    const { breaker, clock } = await halfOpen({ ignoreTimeouts: true });
    await expect(breaker.exec(async () => timeout())).rejects.toBeDefined(); // sonda vencida
    await expect(breaker.exec(async () => fail5xx())).rejects.toMatchObject({ kind: 'server_error' });
    expect(breaker.state).toBe('open');
    await expect(breaker.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' });
    clock.t += 1500;
    expect(breaker.state).toBe('half_open');
    // la nueva ronda semiabierta vuelve a admitir UNA sola sonda: la marca «no concluyente» no sobrevive a la reapertura
    const probe = deferred();
    const probing = breaker.exec(() => probe.promise);
    await expect(breaker.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' });
    probe.resolve('ok');
    await probing;
    expect(breaker.state).toBe('closed');
  });

  it('límite · la marca «no concluyente» tampoco sobrevive a un cierre: si después se vuelve a abrir, el semiabierto admite una sola sonda', async () => {
    const { breaker, clock } = await halfOpen({ ignoreTimeouts: true });
    await expect(breaker.exec(async () => timeout())).rejects.toBeDefined();
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok'); // cierra
    for (let i = 0; i < 2; i += 1) await expect(breaker.exec(async () => fail5xx())).rejects.toBeDefined();
    expect(breaker.state).toBe('open');
    clock.t += 1500;
    const probe = deferred();
    const probing = breaker.exec(() => probe.promise);
    await expect(breaker.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' });
    probe.resolve('ok');
    await probing;
  });

  it('inválido/control · el timeout sigue sin contar ni abrir (ignoreTimeouts) y SIN la opción una sonda vencida reabre el breaker como siempre', async () => {
    const lenient = new CircuitBreaker('pay-risk', { failureThreshold: 2, resetAfterMs: 1000, ignoreTimeouts: true });
    for (let i = 0; i < 100; i += 1) await expect(lenient.exec(async () => timeout())).rejects.toBeDefined();
    expect(lenient.state).toBe('closed');

    const { breaker, clock } = await halfOpen(); // sin ignoreTimeouts
    await expect(breaker.exec(async () => timeout())).rejects.toBeDefined();
    expect(breaker.state).toBe('open'); // reabierto: el timeout cuenta en este breaker
    clock.t += 1500;
    expect(breaker.state).toBe('half_open');
  });
});
