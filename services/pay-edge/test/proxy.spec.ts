import { randomBytes } from 'node:crypto';
import { ROUTES } from '../src/routes';
import { startEdge, type EdgeHarness } from './harness';
import { SAMPLES } from './doubles/samples';
import type { UpstreamName } from '../src/config';

const ID_FOR: Record<string, string> = {
  payment_intents: 'pi_abcdefghij12',
  api_keys: 'key_abcdefghij12',
  webhook_endpoints: 'we_abcdefghij12',
  mandates: 'md_abcdefghij12',
};
const concrete = (template: string): string => template.replace('{id}', ID_FOR[template.split('/')[1]]);
const KEY = 'clave-de-idempotencia-0001';
/**
 * DEFECTO CONOCIDO DEL CONTRATO (docs/trabajo/ola-1/P1/PROPUESTAS.md, propuesta 3): `Mandate` se arma con `allOf` sobre
 * `MandateCreate`, que lleva `additionalProperties: false`; por eso NINGUNA respuesta real de `Mandate` puede validar. Se
 * declara acá, acotado a estas dos operaciones, y una prueba avisa cuando el contrato se corrija (hay que borrar este Set).
 */
const KNOWN_CONTRACT_DEFECT = new Set(['POST /mandates', 'GET /mandates']);
const isKnownDefect = (violation: string) => [...KNOWN_CONTRACT_DEFECT].some((op) => violation.startsWith(`${op.split(' ')[0]} /mandates`));
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

async function authed(h: EdgeHarness) {
  const k = await h.seedKey({ mode: 'test' });
  const auth = `Bearer ${k.token}`;
  for (const [id, svc] of [['pi_abcdefghij12', 'pay-payments'], ['key_abcdefghij12', 'pay-merchants'], ['we_abcdefghij12', 'pay-webhooks'], ['md_abcdefghij12', 'pay-schedules']] as const) h.doubles[svc].own(k.merchantId, id);
  return { ...k, auth };
}

describe('[DOBLE] reenvío a los servicios dueños — nivel CORRECTO', () => {
  let h: EdgeHarness;
  let k: Awaited<ReturnType<typeof authed>>;
  beforeAll(async () => {
    h = await startEdge();
    k = await authed(h);
  });
  afterAll(async () => h.stop());
  afterEach(() => Object.values(h.doubles).forEach((d) => (d.requests.length = 0)));

  it.each(ROUTES.map((r) => [`${r.method} ${r.template}`, r] as const))('%s llega al servicio dueño y la respuesta cumple el contrato', async (name, route) => {
    const path = concrete(route.template);
    let req = h.http()[route.method.toLowerCase() as 'get' | 'post' | 'delete'](`/v1${path}`).set('Authorization', k.auth);
    if (route.idempotencyKey) req = req.set('Idempotency-Key', KEY).set('Content-Type', 'application/json').send('{"x":1}');
    const res = await req;

    const sample = SAMPLES[name];
    expect(res.status).toBe(sample.status);
    if (sample.body !== undefined) expect(res.body).toEqual(sample.body);
    const errors = h.contract.validateResponse({ method: route.method, path, status: res.status, body: sample.body === undefined ? undefined : res.body });
    if (KNOWN_CONTRACT_DEFECT.has(name)) expect(errors.join()).toMatch(/additional properties/i);
    else expect(errors).toEqual([]);

    const seen = h.doubles[route.upstream].requests;
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe(route.method);
    expect(seen[0].url).toBe(path);
    expect(seen[0].headers).toMatchObject({ 'x-service-id': 'pay-edge', 'x-merchant-id': k.merchantId, 'x-pay-mode': 'test', accept: 'application/json' });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-request-id']).toBe(res.headers['x-request-id']);
    expect(seen[0].headers.traceparent).toMatch(TRACEPARENT);
    if (route.idempotencyKey) expect(seen[0].headers['idempotency-key']).toBe(KEY);
    // ningún otro servicio vio la petición
    for (const other of Object.keys(h.doubles).filter((n) => n !== route.upstream)) expect(h.doubles[other as UpstreamName].requests).toHaveLength(0);
  });

  it('ningún doble devolvió una respuesta fuera del contrato', () => {
    for (const d of Object.values(h.doubles)) expect(d.violations.filter((v) => !isKnownDefect(v))).toEqual([]);
  });

  it('DEFECTO CONOCIDO vigente: el contrato todavía rechaza una respuesta real de Mandate (si falla, se corrigió: borrá KNOWN_CONTRACT_DEFECT)', () => {
    const violations = h.doubles['pay-schedules'].violations;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every(isKnownDefect)).toBe(true);
  });

  it('reenvía los BYTES exactos del cuerpo (espacios, orden de claves, unicode, números grandes), sin reserializar', async () => {
    const text = '{ "b" : 2,\n"a":"ñandú ✓ \\u00e9",  "n": 12345678901234567890 }';
    await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', KEY).set('Content-Type', 'application/json').send(text);
    expect(h.doubles['pay-payments'].requests[0].body.equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('reenvía solo los parámetros de consulta del contrato, ya codificados', async () => {
    await h.http().get('/v1/payment_intents?limit=5&status=succeeded&starting_after=abc%20def').set('Authorization', k.auth);
    const url = h.doubles['pay-payments'].requests[0].url;
    expect(new URL(`http://x${url}`).searchParams.get('limit')).toBe('5');
    expect(new URL(`http://x${url}`).searchParams.get('status')).toBe('succeeded');
    expect(new URL(`http://x${url}`).searchParams.get('starting_after')).toBe('abc def');
  });

  it('continúa la traza del cliente (mismo trace id, span nuevo) y reemplaza una traza inválida', async () => {
    const trace = 'a'.repeat(32);
    await h.http().get('/v1/balance').set('Authorization', k.auth).set('traceparent', `00-${trace}-${'b'.repeat(16)}-01`);
    const forwarded = h.doubles['pay-ledger'].requests[0].headers.traceparent as string;
    expect(forwarded).toMatch(TRACEPARENT);
    expect(forwarded.split('-')[1]).toBe(trace);
    expect(forwarded.split('-')[2]).not.toBe('b'.repeat(16));

    h.doubles['pay-ledger'].requests.length = 0;
    await h.http().get('/v1/balance').set('Authorization', k.auth).set('traceparent', 'basura');
    const generated = h.doubles['pay-ledger'].requests[0].headers.traceparent as string;
    expect(generated).toMatch(TRACEPARENT);
    expect(generated.split('-')[1]).not.toBe('basura');
  });

  it('propaga el X-Request-Id del cliente si está bien formado y genera uno si no', async () => {
    const ok = await h.http().get('/v1/balance').set('Authorization', k.auth).set('X-Request-Id', 'mi-id-de-correlacion-1');
    expect(ok.headers['x-request-id']).toBe('mi-id-de-correlacion-1');
    expect(h.doubles['pay-ledger'].requests[0].headers['x-request-id']).toBe('mi-id-de-correlacion-1');
    const bad = await h.http().get('/v1/balance').set('Authorization', k.auth).set('X-Request-Id', 'a b<script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('en sandbox marca la respuesta con X-Pay-Mode: sandbox y prohíbe el caché', async () => {
    const res = await h.http().get('/v1/balance').set('Authorization', k.auth);
    expect(res.headers['x-pay-mode']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['live', 'test', 'sandbox', 'basura'])('D-28: un X-Pay-Mode: %s del cliente se descarta; el modo reenviado es el del registro (test)', async (claimed) => {
    await h.http().get('/v1/balance').set('Authorization', k.auth).set('X-Pay-Mode', claimed).set('x-PAY-mode', claimed);
    const forwarded = h.doubles['pay-ledger'].requests[0].headers['x-pay-mode'];
    expect(forwarded).toBe('test');
  });

  it('deja pasar Idempotency-Replayed del servicio dueño', async () => {
    h.doubles['pay-payments'].override = () => ({ status: 201, body: SAMPLES['POST /payment_intents'].body, headers: { 'idempotency-replayed': 'true' } });
    const res = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', KEY).set('Content-Type', 'application/json').send('{}');
    h.doubles['pay-payments'].override = undefined;
    expect(res.headers['idempotency-replayed']).toBe('true');
  });
});

describe('[DOBLE] reenvío — nivel LÍMITE (lo que el contrato fija)', () => {
  let h: EdgeHarness;
  let k: Awaited<ReturnType<typeof authed>>;
  beforeAll(async () => {
    h = await startEdge({ env: { MAX_BODY_BYTES: '4096' } });
    k = await authed(h);
  });
  afterAll(async () => h.stop());
  afterEach(() => Object.values(h.doubles).forEach((d) => (d.requests.length = 0)));
  const create = (key?: string) => {
    let r = h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Content-Type', 'application/json');
    if (key !== undefined) r = r.set('Idempotency-Key', key);
    return r.send('{}');
  };

  it('REQ-P1-2: sin Idempotency-Key una mutación da 400 idempotency_key_required y NO llega al servicio', async () => {
    const res = await create();
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'idempotency_key_required', status: 400 });
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
    h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 400, body: res.body });
  });

  it.each([
    ['8 caracteres (mínimo)', 'a'.repeat(8), 201],
    ['255 caracteres (máximo)', 'a'.repeat(255), 201],
    ['7 caracteres', 'a'.repeat(7), 422],
    ['256 caracteres', 'a'.repeat(256), 422],
    ['con espacio', 'clave con espacio', 422],
    ['con unicode', 'clave-ñandú-0001', 422],
  ])('Idempotency-Key de %s', async (_name, key, status) => {
    const res = await create(key);
    expect(res.status).toBe(status);
    if (status === 422) {
      expect(res.body.code).toBe('validation_failed');
      expect(h.doubles['pay-payments'].requests).toHaveLength(0);
    }
  });

  it('una mutación que el contrato no marca (DELETE) no exige Idempotency-Key', async () => {
    const res = await h.http().delete('/v1/mandates/md_abcdefghij12').set('Authorization', k.auth);
    expect(res.status).toBe(204);
  });

  it('un parámetro de consulta que el contrato no define da 422 con el campo, y no llega al servicio', async () => {
    const res = await h.http().get('/v1/payment_intents?limit=5&admin=1&x=2').set('Authorization', k.auth);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(expect.arrayContaining([{ field: 'admin', code: 'unknown_parameter' }, { field: 'x', code: 'unknown_parameter' }]));
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
  });

  it('un parámetro repetido (?limit=1&limit=2) se rechaza en vez de elegir uno', async () => {
    const res = await h.http().get('/v1/payment_intents?limit=1&limit=2').set('Authorization', k.auth);
    expect(res.status).toBe(422);
  });

  it('un cuerpo que no es JSON se rechaza; sin cuerpo no hace falta Content-Type', async () => {
    const bad = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', KEY).set('Content-Type', 'text/plain').send('hola');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'content-type', code: 'unsupported_media_type' });
    const empty = await h.http().post('/v1/payment_intents/pi_abcdefghij12/cancel').set('Authorization', k.auth).set('Idempotency-Key', KEY);
    expect(empty.status).toBe(200);
  });

  it('el tamaño máximo del cuerpo se hace cumplir: justo en el límite pasa, un byte más da 422 sin filtrar la pila', async () => {
    const pad = (n: number) => `{"p":"${'a'.repeat(n - 8)}"}`;
    const okBody = pad(4096);
    expect(Buffer.byteLength(okBody)).toBe(4096);
    const ok = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', KEY).set('Content-Type', 'application/json').send(okBody);
    expect(ok.status).toBe(201);
    const big = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', KEY).set('Content-Type', 'application/json').send(pad(4097));
    expect(big.status).toBe(422);
    expect(big.headers['content-type']).toContain('application/problem+json');
    expect(JSON.stringify(big.body)).not.toMatch(/PayloadTooLarge|stack|node_modules|at /);
  });

  it('una ruta o un método que el contrato no define es 404 resource_not_found (autenticado)', async () => {
    for (const [method, path] of [['get', '/v1/nada'], ['put', '/v1/payment_intents/pi_abcdefghij12'], ['get', '/v1/payment_intents/../balance'], ['get', '/v1/payment_intents/pi_abcdefghij12/secreto']] as const) {
      const res = await h.http()[method](path).set('Authorization', k.auth);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('resource_not_found');
    }
  });
});

describe('[DOBLE] reenvío — nivel INVÁLIDO (el servicio de destino se porta mal)', () => {
  let h: EdgeHarness;
  let k: Awaited<ReturnType<typeof authed>>;
  const leak = 'Error: connection to postgres://pay_ledger:secreto@10.0.0.7:5432 refused\n    at Pool.connect (/app/node_modules/pg/lib/pool.js:12:3)';
  beforeAll(async () => {
    // Umbral alto a propósito: acá se prueba cada mala respuesta POR SEPARADO; el cortacircuitos tiene su propio bloque.
    h = await startEdge({ env: { UPSTREAM_TIMEOUT_MS: '400', BREAKER_FAILURE_THRESHOLD: '1000' } });
    k = await authed(h);
  });
  afterAll(async () => h.stop());
  afterEach(() => {
    Object.values(h.doubles).forEach((d) => {
      d.requests.length = 0;
      d.override = undefined;
    });
  });
  const get = (path = '/v1/balance') => h.http().get(path).set('Authorization', k.auth);
  const ledger = () => h.doubles['pay-ledger'];

  it('un 500 con la pila y la cadena de conexión NO llega al comercio: 502 upstream_error genérico', async () => {
    ledger().override = () => ({ status: 500, raw: Buffer.from(leak), headers: { 'content-type': 'text/plain' } });
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'upstream_error', status: 502 });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/postgres|secreto|10\.0\.0\.7|node_modules|Pool\.connect/);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('un 404 en HTML (página de error de un framework) también se reemplaza', async () => {
    ledger().override = () => ({ status: 404, raw: Buffer.from('<html><body>Cannot GET /balance (express 5.0.1)</body></html>'), headers: { 'content-type': 'text/html' } });
    const res = await get();
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/express|html/i);
  });

  it('un 200 que no es JSON se rechaza', async () => {
    ledger().override = () => ({ status: 200, raw: Buffer.from('<html>ok</html>'), headers: { 'content-type': 'text/html' } });
    expect((await get()).status).toBe(502);
  });

  it('un problema RFC 9457 válido pasa, pero SOLO con los campos permitidos (la pila y el SQL se descartan)', async () => {
    ledger().override = () => ({
      status: 422,
      body: { type: 'urn:alovida:pay:problem:insufficient_funds', title: 'Fondos insuficientes', status: 422, code: 'insufficient_funds', detail: 'Saldo menor al débito', stack: leak, sql: 'SELECT * FROM ledger WHERE pan = 4111111111111111', internal_host: '10.0.0.7' },
    });
    const res = await get();
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ type: 'urn:alovida:pay:problem:insufficient_funds', title: 'Fondos insuficientes', status: 422, code: 'insufficient_funds', detail: 'Saldo menor al débito' });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|sql|4111|10\.0\.0\.7/);
  });

  it.each([
    ['sin código', { type: 't', title: 't', status: 422 }],
    ['código con mayúsculas', { type: 't', title: 't', status: 422, code: 'Insufficient-Funds' }],
    ['no es un objeto', ['x']],
  ])('un problema inválido (%s) se reemplaza por 502', async (_name, body) => {
    ledger().override = () => ({ status: 422, body });
    expect((await get()).status).toBe(502);
  });

  it('NO sigue redirecciones: un 302 hacia un host interno es 502 y solo hubo una petición', async () => {
    ledger().override = () => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, raw: Buffer.alloc(0) });
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
    expect(ledger().requests).toHaveLength(1);
  });

  it('un servicio que no responde da 504 upstream_timeout (y la causa no se filtra)', async () => {
    ledger().override = () => 'hang';
    const started = Date.now();
    const res = await get();
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ code: 'upstream_timeout', status: 504 });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('una conexión cortada a la mitad da 503 upstream_unavailable', async () => {
    ledger().override = () => 'destroy';
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('upstream_unavailable');
  });

  it('una respuesta de más de 2 MB se rechaza', async () => {
    ledger().override = () => ({ status: 200, raw: Buffer.alloc(2 * 1024 * 1024 + 10, 0x61), headers: { 'content-type': 'application/json' } });
    expect((await get()).status).toBe(502);
  });

  it('un 5xx con un problema válido (p. ej. risk_unavailable) es una respuesta deliberada: pasa y NO abre el cortacircuitos', async () => {
    h.doubles['pay-payments'].override = () => ({ status: 503, body: { type: 'urn:alovida:pay:problem:risk_unavailable', title: 'El control de riesgo no está disponible', status: 503, code: 'risk_unavailable' } });
    for (let i = 0; i < 6; i += 1) {
      const res = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', `clave-repetida-${i}-0001`).set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('risk_unavailable');
    }
    expect(h.doubles['pay-payments'].requests).toHaveLength(6); // las seis llegaron
  });
});

describe('[DOBLE] cortacircuitos del borde', () => {
  let h: EdgeHarness;
  let k: Awaited<ReturnType<typeof authed>>;
  beforeAll(async () => {
    h = await startEdge({ env: { UPSTREAM_TIMEOUT_MS: '400', BREAKER_FAILURE_THRESHOLD: '3', BREAKER_COOLDOWN_MS: '600' } });
    k = await authed(h);
  });
  afterAll(async () => h.stop());
  const get = (path = '/v1/balance') => h.http().get(path).set('Authorization', k.auth);
  const ledger = () => h.doubles['pay-ledger'];

  it('cortacircuitos: tras 3 fallos seguidos el 4.º no llega al servicio (503 + Retry-After), y se recupera con una prueba', async () => {
    ledger().requests.length = 0;
    ledger().override = () => 'destroy';
    for (let i = 0; i < 3; i += 1) expect((await get()).status).toBe(503);
    expect(ledger().requests).toHaveLength(3);

    const blocked = await get();
    expect(blocked.status).toBe(503);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(ledger().requests).toHaveLength(3); // el cuarto NO salió

    ledger().override = undefined; // el servicio se recupera
    const deadline = Date.now() + 5_000;
    let res = await get();
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      res = await get();
    }
    expect(res.status).toBe(200);
    expect((await get()).status).toBe(200);
  });

  it('un 5xx con un problema válido (p. ej. risk_unavailable) es una respuesta deliberada: pasa y NO abre el cortacircuitos', async () => {
    h.doubles['pay-payments'].override = () => ({ status: 503, body: { type: 'urn:alovida:pay:problem:risk_unavailable', title: 'El control de riesgo no está disponible', status: 503, code: 'risk_unavailable' } });
    for (let i = 0; i < 6; i += 1) {
      const res = await h.http().post('/v1/payment_intents').set('Authorization', k.auth).set('Idempotency-Key', `clave-repetida-${i}-0001`).set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('risk_unavailable');
    }
    expect(h.doubles['pay-payments'].requests).toHaveLength(6); // las seis llegaron
  });
});

describe('[DOBLE] cortacircuitos del borde', () => {
  let h: EdgeHarness;
  let k: Awaited<ReturnType<typeof authed>>;
  beforeAll(async () => {
    h = await startEdge({ env: { UPSTREAM_TIMEOUT_MS: '400', BREAKER_FAILURE_THRESHOLD: '3', BREAKER_COOLDOWN_MS: '600' } });
    k = await authed(h);
  });
  afterAll(async () => h.stop());
  const get = (path = '/v1/balance') => h.http().get(path).set('Authorization', k.auth);
  const ledger = () => h.doubles['pay-ledger'];

  it('cortacircuitos: tras 3 fallos seguidos el 4.º no llega al servicio (503 + Retry-After), y se recupera con una prueba', async () => {
    ledger().requests.length = 0;
    ledger().override = () => 'destroy';
    for (let i = 0; i < 3; i += 1) expect((await get()).status).toBe(503);
    expect(ledger().requests).toHaveLength(3);

    const blocked = await get();
    expect(blocked.status).toBe(503);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(ledger().requests).toHaveLength(3); // el cuarto NO salió

    ledger().override = undefined; // el servicio se recupera
    const deadline = Date.now() + 5_000;
    let res = await get();
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      res = await get();
    }
    expect(res.status).toBe(200);
    expect((await get()).status).toBe(200);
  });

  it('el cortacircuitos es POR servicio: con pay-ledger caído, pay-payments sigue sirviendo', async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    ledger().override = () => 'destroy';
    for (let i = 0; i < 4; i += 1) await get();
    const other = await h.http().get('/v1/payment_intents/pi_abcdefghij12').set('Authorization', k.auth);
    expect(other.status).toBe(200);
  });

  it('el cortacircuitos es POR servicio: con pay-ledger caído, pay-payments sigue sirviendo', async () => {
    ledger().override = () => 'destroy';
    for (let i = 0; i < 4; i += 1) await get();
    const other = await h.http().get('/v1/payment_intents/pi_abcdefghij12').set('Authorization', k.auth);
    expect(other.status).toBe(200);
  });
});

describe('puerto cerrado (servicio caído de verdad)', () => {
  it('da 503 upstream_unavailable sin colgarse', async () => {
    const h = await startEdge({ upstreamUrls: { 'pay-ledger': 'http://127.0.0.1:1' } });
    try {
      const k = await h.seedKey();
      const res = await h.http().get('/v1/balance').set('Authorization', `Bearer ${k.token}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('upstream_unavailable');
      expect(randomBytes(1).length).toBe(1);
    } finally {
      await h.stop();
    }
  });
});
