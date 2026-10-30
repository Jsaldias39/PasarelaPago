import { randomBytes, randomUUID } from 'node:crypto';
import { generateRequestId, resolveRequestId } from '@pay/idempotency';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { firstValueFrom, of } from 'rxjs';
import { delay, map } from 'rxjs/operators';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { HttpClient } from '../src/clients/http';
import { captureTraceCarrier, currentRequestId, inActivityTrace, isValidRequestId, runWithRequestId } from '../src/observability/trace-propagation';
import { RequestScopeInterceptor } from '../src/observability/request-scope.interceptor';
import { dumpOf, exported, idOf, inServerSpan, parentIdOf, spansNamed, startTestTracing } from './helpers/otel';

/**
 * P1.H2.M3 (T2, T3): el contexto de la petición de origen (traceparent + x-request-id) cruza hasta las llamadas a riesgo, conector y ledger. Tres niveles por pieza:
 * correcto, límite (no muestreado, versión futura, id de 64/65 caracteres o con forma de PAN) e inválido (traceparent malformado, carrier basura, destino que falla).
 * No requiere Postgres ni Temporal; el cruce real por el workflow está en `trace.workflow.spec.ts`.
 */
const W3C = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(() => startTestTracing());
beforeEach(() => exported.reset());

describe('isValidRequestId / runWithRequestId', () => {
  it('CORRECTO: ids de 8 a 64 caracteres [A-Za-z0-9._-] son válidos y quedan disponibles dentro del alcance (también tras un await)', async () => {
    expect(currentRequestId()).toBeUndefined();
    const seen = await runWithRequestId('traza-pend-0123abcd', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentRequestId();
    });
    expect(seen).toBe('traza-pend-0123abcd');
    expect(currentRequestId()).toBeUndefined();
  });

  it.each([
    ['8 caracteres', 'a'.repeat(8), true],
    ['64 caracteres', 'a'.repeat(64), true],
    ['7 caracteres', 'a'.repeat(7), false],
    ['65 caracteres', 'a'.repeat(65), false],
    ['con espacio', 'id con espacio', false],
    ['con símbolos', '<script>alert(1)</script>', false],
    ['con forma de PAN (Luhn)', 'req-4111111111111111', false],
    ['vacío', '', false],
  ])('LÍMITE/INVÁLIDO: %s', (_name, id, valid) => {
    expect(isValidRequestId(id)).toBe(valid);
    expect(runWithRequestId(id, () => currentRequestId())).toBe(valid ? id : undefined);
  });

  it('INVÁLIDO: lo que no es texto no abre alcance ni lanza', () => {
    for (const value of [undefined, null, 42, {}, ['a'.repeat(10)]]) expect(runWithRequestId(value, () => currentRequestId())).toBeUndefined();
  });
});

describe('captureTraceCarrier + inActivityTrace (el cruce de Temporal como dato)', () => {
  it('CORRECTO: el carrier lleva el traceparent del span activo y el id; la activity corre como HIJO del mismo span, en la misma traza y con el mismo id', async () => {
    const requestId = `traza-${hex(6)}`;
    let startSpanId = '';
    const carrier = await runWithRequestId(requestId, () =>
      trace.getTracer('t').startActiveSpan('start', (span) => {
        startSpanId = span.spanContext().spanId;
        const c = captureTraceCarrier();
        span.end();
        return c;
      }),
    );
    expect(carrier).toBeDefined();
    const m = W3C.exec(carrier!.traceparent!)!;
    expect(m[2]).toBe(startSpanId);
    expect(carrier!.requestId).toBe(requestId);

    // Otro «proceso»: sin contexto activo ni alcance; solo el carrier (JSON, como viaja por Temporal).
    const inside = await context.with(ROOT_CONTEXT, () =>
      inActivityTrace('assessRisk', JSON.parse(JSON.stringify(carrier)), 2, async () => ({ requestId: currentRequestId(), active: trace.getActiveSpan()?.spanContext() })),
    );
    const [activity] = spansNamed('activity assessRisk');
    expect(activity!.kind).toBe(SpanKind.INTERNAL);
    expect(activity!.spanContext().traceId).toBe(m[1]);
    expect(parentIdOf(activity!)).toBe(startSpanId);
    expect(activity!.attributes).toEqual({ 'temporal.activity.type': 'assessRisk', 'temporal.activity.attempt': 2 });
    expect(inside.requestId).toBe(requestId);
    expect(inside.active!.spanId).toBe(idOf(activity!));
  });

  it('CORRECTO: sin SDK activo y sin id (nada que llevar) el carrier es undefined', () => {
    expect(context.with(ROOT_CONTEXT, () => captureTraceCarrier())).toBeUndefined();
  });

  it('LÍMITE: carrier NO muestreado (flags 00) ⇒ no se exporta el span de la activity y lo que se inyecte adentro sigue en 00', async () => {
    const tid = hex(16);
    const injected = await inActivityTrace('createCharge', { traceparent: `00-${tid}-${hex(8)}-00`, requestId: 'id-no-muestreado' }, undefined, async () => {
      const out: Record<string, string> = {};
      propagation.inject(context.active(), out);
      return out.traceparent;
    });
    expect(injected).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
    expect(spansNamed('activity createCharge')).toHaveLength(0);
  });

  it('LÍMITE: traceparent de VERSIÓN FUTURA en el carrier ⇒ lo que decida el SDK; la activity corre en esa misma traza (o en una nueva si lo rechazó) sin lanzar', async () => {
    const tid = hex(16);
    const header = `01-${tid}-${hex(8)}-01-extra-futuro`;
    const accepted = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent: header }))?.traceId;
    await inActivityTrace('recordLedger', { traceparent: header }, undefined, async () => 'ok');
    const [activity] = spansNamed('activity recordLedger');
    expect(activity!.spanContext().traceId).toBe(accepted ?? activity!.spanContext().traceId);
    if (accepted === undefined) {
      expect(activity!.spanContext().traceId).not.toBe(tid);
      expect(parentIdOf(activity!)).toBeUndefined();
    }
  });

  it('LÍMITE: id de 64 caracteres se conserva en la activity; de 65 no (las llamadas generarán el suyo)', async () => {
    expect(await inActivityTrace('x', { requestId: 'a'.repeat(64) }, undefined, async () => currentRequestId())).toBe('a'.repeat(64));
    expect(await inActivityTrace('x', { requestId: 'a'.repeat(65) }, undefined, async () => currentRequestId())).toBeUndefined();
  });

  it('INVÁLIDO: carrier ausente (workflow en vuelo de antes del campo) ⇒ traza NUEVA raíz, sin id, y el resultado de la activity sale intacto', async () => {
    const out = await inActivityTrace('assessRisk', undefined, undefined, async () => ({ proceed: true, requestId: currentRequestId() }));
    expect(out).toEqual({ proceed: true, requestId: undefined });
    const [activity] = spansNamed('activity assessRisk');
    expect(parentIdOf(activity!)).toBeUndefined();
  });

  it.each([
    ['basura', 'basura'],
    ['ceros', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['mayúsculas', `00-${hex(16).toUpperCase()}-${hex(8).toUpperCase()}-01`],
    ['versión ff', `ff-${hex(16)}-${hex(8)}-01`],
    ['larguísimo', `00-${'a'.repeat(5000)}`],
    ['vacío', ''],
    ['no es texto (número)', 12345],
    ['no es texto (objeto)', { traceparent: 'x' }],
  ])('INVÁLIDO: traceparent %s en el carrier ⇒ traza nueva (raíz) y la activity corre igual', async (_name, bad) => {
    const result = await inActivityTrace('assessRisk', { traceparent: bad as unknown as string, requestId: 'id-con-traza-mala' }, undefined, async () => currentRequestId());
    expect(result).toBe('id-con-traza-mala');
    const [activity] = spansNamed('activity assessRisk');
    expect(parentIdOf(activity!)).toBeUndefined();
  });

  it('INVÁLIDO: una activity que falla relanza EL MISMO error y el span queda en ERROR sin mensaje ni excepción', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.9:5432 secreto-interno');
    await expect(inActivityTrace('createCharge', { traceparent: `00-${hex(16)}-${hex(8)}-01` }, 1, async () => Promise.reject(boom))).rejects.toBe(boom);
    const [activity] = spansNamed('activity createCharge');
    expect(activity!.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(activity!.events).toHaveLength(0);
    expect(dumpOf(activity!)).not.toMatch(/ECONNREFUSED|secreto-interno|10\.0\.0\.9/);
  });
});

describe('HttpClient — traceparent del contexto activo y x-request-id de la petición de origen', () => {
  let server: Server;
  let baseUrl: string;
  const seen: Record<string, string | string[] | undefined>[] = [];
  let behavior: (n: number) => { status: number; body: string } = () => ({ status: 200, body: '{"ok":true}' });
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      const r = behavior(seen.length);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    seen.length = 0;
    behavior = () => ({ status: 200, body: '{"ok":true}' });
  });
  const client = (retries = 0, timeoutMs = 2000) => new HttpClient({ name: 'pay-risk', baseUrl, serviceId: 'pay-payments', timeoutMs, retries, breaker: { failureThreshold: 50, resetAfterMs: 60_000 } });

  it('CORRECTO: dentro de una petición (traza + id) la llamada lleva SU traceId, el spanId del span cliente exportado y el MISMO x-request-id; el span cuelga del activo', async () => {
    const { traceId, spanId } = await inServerSpan(undefined, () => runWithRequestId('traza-pend-aaaa1111', () => client().request({ method: 'POST', path: '/assessments', body: {}, idempotencyKey: 'k-0000000001' })));
    const m = W3C.exec(seen[0]!.traceparent as string)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(traceId);
    const [span] = spansNamed('POST pay-risk');
    expect(m[2]).toBe(idOf(span!));
    expect(parentIdOf(span!)).toBe(spanId);
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(seen[0]!['x-request-id']).toBe('traza-pend-aaaa1111');
    expect(seen[0]!['idempotency-key']).toBe('k-0000000001');
    expect(seen[0]!['x-service-id']).toBe('pay-payments');
    // El cuerpo JSON viaja con su content-type (sin él el servicio de destino no lo interpreta y responde 422).
    expect(seen[0]!['content-type']).toBe('application/json');
  });

  it('LÍMITE: una llamada sin cuerpo (GET) no declara content-type', async () => {
    await client().request({ method: 'GET', path: '/a' });
    expect(seen[0]!['content-type']).toBeUndefined();
  });

  it('CORRECTO: los REINTENTOS de una llamada llevan el mismo x-request-id y el mismo idempotency-key (cada intento tiene su propio span)', async () => {
    behavior = (n) => (n === 1 ? { status: 503, body: '{}' } : { status: 200, body: '{"ok":true}' });
    await runWithRequestId('traza-reintento-1', () => client(1).request({ method: 'POST', path: '/x', body: {}, idempotencyKey: 'k-0000000002' }));
    expect(seen).toHaveLength(2);
    expect(seen.map((h) => h['x-request-id'])).toEqual(['traza-reintento-1', 'traza-reintento-1']);
    expect(seen.map((h) => h['idempotency-key'])).toEqual(['k-0000000002', 'k-0000000002']);
    expect(new Set(seen.map((h) => h.traceparent)).size).toBe(2);
    expect(spansNamed('POST pay-risk')).toHaveLength(2);
  });

  it('CORRECTO: sin petición de origen (un timer, un consumidor) cada llamada genera su propio UUID, como antes', async () => {
    await context.with(ROOT_CONTEXT, async () => {
      await client().request({ method: 'GET', path: '/a' });
      await client().request({ method: 'GET', path: '/b' });
    });
    expect(seen[0]!['x-request-id']).toMatch(UUID);
    expect(seen[1]!['x-request-id']).toMatch(UUID);
    expect(seen[0]!['x-request-id']).not.toBe(seen[1]!['x-request-id']);
  });

  it('LÍMITE: un x-request-id explícito y válido gana al del alcance; uno inválido (espacios, 65 caracteres, forma de PAN) se reemplaza por el del alcance', async () => {
    await runWithRequestId('traza-del-alcance-1', async () => {
      await client().request({ method: 'GET', path: '/a', headers: { 'X-Request-Id': 'explicito-valido-1' } });
      for (const bad of ['con espacio', 'a'.repeat(65), 'r-4111111111111111']) await client().request({ method: 'GET', path: '/b', headers: { 'x-request-id': bad } });
    });
    expect(seen.map((h) => h['x-request-id'])).toEqual(['explicito-valido-1', 'traza-del-alcance-1', 'traza-del-alcance-1', 'traza-del-alcance-1']);
  });

  it('LÍMITE: contexto NO muestreado ⇒ viaja con flags 00 y no se exporta ningún span cliente', async () => {
    const tid = hex(16);
    const parent = propagation.extract(ROOT_CONTEXT, { traceparent: `00-${tid}-${hex(8)}-00` });
    await context.with(parent, () => client().request({ method: 'GET', path: '/a' }));
    expect(seen[0]!.traceparent).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
    expect(spansNamed('GET pay-risk')).toHaveLength(0);
  });

  it('LÍMITE: un traceparent/tracestate/baggage que pase el llamador en headers se descarta; solo viaja el del contexto activo', async () => {
    const spoofed = `00-${hex(16)}-${hex(8)}-01`;
    const { traceId } = await inServerSpan(undefined, () => client().request({ method: 'GET', path: '/a', headers: { Traceparent: spoofed, tracestate: 'a=b', Baggage: 'x=y' } }));
    expect(seen[0]!.traceparent).not.toBe(spoofed);
    expect((seen[0]!.traceparent as string).split('-')[1]).toBe(traceId);
    expect(seen[0]!.tracestate).toBeUndefined();
    expect(seen[0]!.baggage).toBeUndefined();
  });

  it('LÍMITE: el span cliente lleva solo atributos de una lista cerrada (nada de ruta, cuerpo, cabeceras ni claves)', async () => {
    await inServerSpan(undefined, () => client().request({ method: 'POST', path: '/assessments/pi_4111111111111111?x=1', body: { pan: '4111111111111111' }, idempotencyKey: 'k-SECRETO-0001', headers: { authorization: 'Bearer sk_test_SECRETO' } }));
    const [span] = spansNamed('POST pay-risk');
    expect(Object.keys(span!.attributes).sort()).toEqual(['http.request.method', 'http.response.status_code', 'peer.service']);
    expect(dumpOf(span!)).not.toMatch(/SECRETO|4111|assessments|x=1/);
  });

  it('INVÁLIDO: un 5xx sigue siendo UpstreamError(server_error) y deja el span en ERROR sin cuerpo ni mensaje', async () => {
    behavior = () => ({ status: 500, body: '{"detalle":"secreto-interno 10.0.0.9"}' });
    await expect(inServerSpan(undefined, () => client().request({ method: 'GET', path: '/a' }))).rejects.toMatchObject({ name: 'UpstreamError', kind: 'server_error', status: 500 });
    const [span] = spansNamed('GET pay-risk');
    expect(span!.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span!.attributes['http.response.status_code']).toBe(500);
    expect(dumpOf(span!)).not.toMatch(/secreto-interno|10\.0\.0\.9/);
  });

  it('INVÁLIDO: destino caído o lento ⇒ UpstreamError network/timeout (igual que antes) y el span en ERROR', async () => {
    const down = new HttpClient({ name: 'pay-risk', baseUrl: 'http://127.0.0.1:1', serviceId: 'pay-payments', timeoutMs: 500, retries: 0, breaker: { failureThreshold: 50, resetAfterMs: 60_000 } });
    await expect(down.request({ method: 'GET', path: '/a' })).rejects.toMatchObject({ kind: 'network' });
    const [span] = spansNamed('GET pay-risk');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    const silent = createServer(() => undefined); // acepta y nunca responde
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      exported.reset();
      const slow = new HttpClient({ name: 'pay-risk', baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, serviceId: 'pay-payments', timeoutMs: 100, retries: 0, breaker: { failureThreshold: 50, resetAfterMs: 60_000 } });
      await expect(slow.request({ method: 'GET', path: '/a' })).rejects.toMatchObject({ kind: 'timeout' });
      expect(spansNamed('GET pay-risk')[0]!.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('RequestScopeInterceptor', () => {
  const run = (request: unknown, type = 'http') =>
    firstValueFrom(
      new RequestScopeInterceptor().intercept({ getType: () => type, switchToHttp: () => ({ getRequest: () => request }) } as never, {
        handle: () => of(null).pipe(delay(5), map(() => currentRequestId())),
      }),
    );

  it('CORRECTO: el manejador (aun tras un retraso asíncrono) ve el id de la petición', async () => {
    expect(await run({ id: 'traza-pend-bbbb2222' })).toBe('traza-pend-bbbb2222');
    expect(currentRequestId()).toBeUndefined();
  });
  it('LÍMITE: un id de 64 caracteres pasa; de 65 o con forma de PAN no abre alcance', async () => {
    expect(await run({ id: 'a'.repeat(64) })).toBe('a'.repeat(64));
    expect(await run({ id: 'a'.repeat(65) })).toBeUndefined();
    expect(await run({ id: 'r-4111111111111111' })).toBeUndefined();
  });
  it('INVÁLIDO: petición sin id, contexto que no es http o un id que no es texto: el manejador corre igual, sin alcance', async () => {
    expect(await run({})).toBeUndefined();
    expect(await run({ id: 42 })).toBeUndefined();
    expect(await run({ id: 'traza-pend-cccc3333' }, 'rpc')).toBeUndefined();
  });
});

describe('S-03 · pay-payments valida el id de petición con la MISMA función que el borde y los demás servicios', () => {
  const LUHN_BY_CHANCE = '0ebff702-5185-4350-8802-cb20d183f879'; // UUID v4 cuya corrida de dígitos cumple Luhn por azar

  it('CORRECTO: un id generado por el borde (resolveRequestId) o por un cliente interno (generateRequestId) NUNCA lo descarta pay-payments: 20 000 muestras, 0 inconsistencias', () => {
    let inconsistent = 0;
    for (let i = 0; i < 20_000; i += 1) {
      if (!isValidRequestId(resolveRequestId(undefined))) inconsistent += 1;
      if (!isValidRequestId(generateRequestId())) inconsistent += 1;
    }
    expect(inconsistent).toBe(0);
  });

  it('LÍMITE: los UUID v4 al azar que el validador rechaza existen (instrumento), y un id del cliente así se reemplaza por uno que pay-payments acepta', () => {
    let rejected = 0;
    for (let i = 0; i < 5_000; i += 1) if (!isValidRequestId(randomUUID())) rejected += 1;
    expect(rejected).toBeGreaterThan(0);
    expect(isValidRequestId(LUHN_BY_CHANCE)).toBe(false);
    expect(isValidRequestId(resolveRequestId(LUHN_BY_CHANCE))).toBe(true);
  });

  it('INVÁLIDO: un id con forma de UUID que contiene un PAN se descarta también acá (sin exención de UUID canónicos)', () => {
    expect(isValidRequestId('41111111-1111-1111-1111-111111111111')).toBe(false);
    expect(runWithRequestId('41111111-1111-1111-1111-111111111111', () => currentRequestId())).toBeUndefined();
  });
});
