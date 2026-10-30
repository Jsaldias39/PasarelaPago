import { randomBytes } from 'node:crypto';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { UpstreamClient } from '../src/proxy/upstream.client';
import { startEdge, type EdgeHarness } from './harness';
import { dumpOf, exported, parentIdOf, spansNamed, startTestTracing } from './helpers/otel';

/**
 * P1.H2.M3 (T1): el borde reenvía el contexto ACTIVO de OpenTelemetry y abre un span CLIENTE real alrededor del reenvío, de modo que el span servidor del servicio dueño
 * cuelgue de un span que SÍ se exporta. Tres niveles: correcto, límite (no muestreado, versión futura, id de 64/65 caracteres) e inválido (traceparent malformado,
 * destino caído). La instrumentación http real se prueba contra Jaeger en e2e/flows/traza-jaeger-arbol.e2e.ts; acá es el doble de `helpers/otel.ts`.
 */
const W3C = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const KEY = 'clave-de-idempotencia-0001';

describe('UpstreamClient — span cliente y traceparent (sin Postgres)', () => {
  const urls = { 'pay-payments': 'http://x', 'pay-merchants': 'http://x', 'pay-schedules': 'http://x', 'pay-webhooks': 'http://x', 'pay-ledger': 'http://x', 'pay-settlement': 'http://x' } as const;
  const seen: Record<string, string>[] = [];
  const client = (impl?: typeof fetch) =>
    new UpstreamClient({
      urls,
      timeoutMs: 500,
      failureThreshold: 5,
      cooldownMs: 1000,
      fetchImpl:
        impl ??
        (async (_url, init) => {
          seen.push({ ...(init?.headers as Record<string, string>) });
          return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }),
    });
  const request = (headers: Record<string, string> = {}) => ({ upstream: 'pay-ledger' as const, method: 'GET', path: '/balance', query: '', headers, body: Buffer.alloc(0) });
  beforeAll(() => startTestTracing());
  beforeEach(() => {
    seen.length = 0;
    exported.reset();
  });

  it('CORRECTO: dentro de un span activo reenvía SU traceId y el spanId del span cliente exportado (hijo del activo)', async () => {
    await trace.getTracer('t').startActiveSpan('padre', async (parent) => {
      await client().forward(request({ 'x-request-id': 'id-de-correlacion-1' }));
      parent.end();
      const [header] = seen;
      const m = W3C.exec(header!.traceparent!);
      expect(m).not.toBeNull();
      const forwardSpan = spansNamed('forward pay-ledger')[0]!;
      expect(m![1]).toBe(parent.spanContext().traceId);
      expect(m![2]).toBe(forwardSpan.spanContext().spanId);
      expect(parentIdOf(forwardSpan)).toBe(parent.spanContext().spanId);
      expect(forwardSpan.kind).toBe(SpanKind.CLIENT);
      expect(header!['x-request-id']).toBe('id-de-correlacion-1');
    });
  });

  it('CORRECTO: un traceparent que ponga el llamador en los headers se REEMPLAZA por el del contexto activo (y tracestate/baggage no pasan)', async () => {
    const spoofed = `00-${hex(16)}-${hex(8)}-01`;
    await trace.getTracer('t').startActiveSpan('padre', async (parent) => {
      await client().forward(request({ Traceparent: spoofed, TraceState: 'v=1', baggage: 'a=b', accept: 'application/json' }));
      parent.end();
      const names = Object.keys(seen[0]!).map((n) => n.toLowerCase());
      expect(names.filter((n) => n === 'traceparent')).toHaveLength(1);
      expect(seen[0]!.traceparent).not.toBe(spoofed);
      expect(seen[0]!.traceparent!.split('-')[1]).toBe(parent.spanContext().traceId);
      expect(names).not.toContain('tracestate');
      expect(names).not.toContain('baggage');
      expect(seen[0]!.accept).toBe('application/json');
    });
  });

  it('LÍMITE: contexto NO muestreado (flags 00) ⇒ se reenvía con flags 00 y no se exporta ningún span cliente', async () => {
    const tid = hex(16);
    const sid = hex(8);
    const parent = propagation.extract(ROOT_CONTEXT, { traceparent: `00-${tid}-${sid}-00` });
    await context.with(parent, () => client().forward(request()));
    expect(seen[0]!.traceparent).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
    expect(spansNamed('forward pay-ledger')).toHaveLength(0);
  });

  it('LÍMITE: sin span activo el traceparent es el del PROPIO span cliente (traza nueva real y exportada), no uno fabricado', async () => {
    await context.with(ROOT_CONTEXT, () => client().forward(request()));
    const [forwardSpan] = spansNamed('forward pay-ledger');
    expect(parentIdOf(forwardSpan!)).toBeUndefined();
    expect(seen[0]!.traceparent).toBe(`00-${forwardSpan!.spanContext().traceId}-${forwardSpan!.spanContext().spanId}-01`);
  });

  it('LÍMITE: el span cliente lleva solo atributos de una lista cerrada (sin URL, cuerpo, cabeceras ni clave)', async () => {
    await trace.getTracer('t').startActiveSpan('padre', async (parent) => {
      await client().forward({ ...request({ authorization: 'Bearer sk_test_SECRETO', 'idempotency-key': KEY }), path: '/payment_intents/pi_4111111111111111', query: '?limit=5' });
      parent.end();
    });
    const [span] = spansNamed('forward pay-ledger');
    expect(Object.keys(span!.attributes).sort()).toEqual(['http.request.method', 'http.response.status_code', 'peer.service']);
    expect(dumpOf(span!)).not.toMatch(/SECRETO|4111|limit=5|payment_intents/);
  });

  it('INVÁLIDO: un destino caído deja el span en ERROR sin mensaje ni excepción, y el error al llamador es el de siempre (503)', async () => {
    const down = client(async () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.9:5432 secreto-interno');
    });
    await trace.getTracer('t').startActiveSpan('padre', async (parent) => {
      await expect(down.forward(request())).rejects.toThrow('upstream_unavailable');
      parent.end();
    });
    const [span] = spansNamed('forward pay-ledger');
    expect(span!.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span!.events).toHaveLength(0);
    expect(dumpOf(span!)).not.toMatch(/ECONNREFUSED|secreto-interno|10\.0\.0\.9/);
  });

  it('INVÁLIDO: con el cortacircuitos abierto no se abre span ni se llama al destino', async () => {
    const calls: number[] = [];
    const c = new UpstreamClient({ urls, timeoutMs: 100, failureThreshold: 1, cooldownMs: 60_000, fetchImpl: async () => { calls.push(1); throw new TypeError('x'); } });
    await expect(c.forward(request())).rejects.toBeDefined();
    exported.reset();
    await expect(c.forward(request())).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
    expect(spansNamed('forward')).toHaveLength(0);
  });
});

describe('pay-edge — tubería completa: una traza por petición, con padre real y request-id de extremo a extremo', () => {
  let h: EdgeHarness;
  let auth: string;
  beforeAll(async () => {
    h = await startEdge({ tracing: true });
    auth = `Bearer ${(await h.seedKey({ mode: 'test' })).token}`;
  });
  afterAll(async () => h.stop());
  beforeEach(() => {
    exported.reset();
    h.doubles['pay-ledger'].requests.length = 0;
  });

  const call = (headers: Record<string, string> = {}) => {
    let req = h.http().get('/v1/balance').set('Authorization', auth);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };
  const forwarded = () => h.doubles['pay-ledger'].requests[0]!.headers;
  const serverSpan = () => exported.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER)!;
  const clientSpan = () => spansNamed('forward pay-ledger')[0]!;

  it('CORRECTO: SIN traceparent entrante, el reenviado pertenece a la MISMA traza del span servidor y cuelga de un span cliente exportado', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const m = W3C.exec(forwarded().traceparent as string)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(serverSpan().spanContext().traceId);
    expect(m[2]).toBe(clientSpan().spanContext().spanId);
    expect(parentIdOf(clientSpan())).toBe(serverSpan().spanContext().spanId);
    expect(parentIdOf(serverSpan())).toBeUndefined(); // raíz: traza nueva
  });

  it('CORRECTO: con traceparent válido del cliente continúa SU traza: el servidor cuelga del span del cliente y el reenviado cuelga del cliente-span del borde', async () => {
    const tid = hex(16);
    const sid = hex(8);
    await call({ traceparent: `00-${tid}-${sid}-01` });
    const m = W3C.exec(forwarded().traceparent as string)!;
    expect(m[1]).toBe(tid);
    expect(m[2]).toBe(clientSpan().spanContext().spanId);
    expect(m[2]).not.toBe(sid);
    expect(parentIdOf(serverSpan())).toBe(sid);
    expect(parentIdOf(clientSpan())).toBe(serverSpan().spanContext().spanId);
  });

  it('CORRECTO: el x-request-id del cliente llega intacto al servicio dueño y vuelve en la respuesta', async () => {
    const res = await call({ 'x-request-id': 'traza-pend-0123abcd' });
    expect(res.headers['x-request-id']).toBe('traza-pend-0123abcd');
    expect(forwarded()['x-request-id']).toBe('traza-pend-0123abcd');
  });

  it('LÍMITE: traceparent NO muestreado ⇒ 200, el reenviado conserva traceId y flags 00, y no se exporta ningún span', async () => {
    const tid = hex(16);
    const res = await call({ traceparent: `00-${tid}-${hex(8)}-00` });
    expect(res.status).toBe(200);
    expect(forwarded().traceparent).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
    expect(exported.getFinishedSpans()).toHaveLength(0);
  });

  it('LÍMITE: traceparent de VERSIÓN FUTURA ⇒ 200 y el borde reenvía exactamente la traza que el SDK aceptó (o una nueva si el SDK la rechazó): nunca discrepan', async () => {
    const tid = hex(16);
    const header = `01-${tid}-${hex(8)}-01-extra-futuro`;
    const accepted = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent: header }))?.traceId;
    const res = await call({ traceparent: header });
    expect(res.status).toBe(200);
    const m = W3C.exec(forwarded().traceparent as string)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(serverSpan().spanContext().traceId);
    expect(m[1]).toBe(accepted ?? serverSpan().spanContext().traceId);
    if (accepted === undefined) expect(m[1]).not.toBe(tid);
  });

  it('LÍMITE: x-request-id de 64 caracteres se conserva; de 65 se reemplaza por un UUID que viaja igual en la respuesta y al servicio', async () => {
    const ok = 'a'.repeat(64);
    expect((await call({ 'x-request-id': ok })).headers['x-request-id']).toBe(ok);
    expect(forwarded()['x-request-id']).toBe(ok);
    h.doubles['pay-ledger'].requests.length = 0;
    const res = await call({ 'x-request-id': 'a'.repeat(65) });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwarded()['x-request-id']).toBe(res.headers['x-request-id']);
  });

  it('LÍMITE: tracestate y baggage del cliente no se reenvían a los servicios internos', async () => {
    await call({ traceparent: `00-${hex(16)}-${hex(8)}-01`, tracestate: 'cliente=valor', baggage: 'a=b' });
    expect(forwarded().tracestate).toBeUndefined();
    expect(forwarded().baggage).toBeUndefined();
  });

  it.each([
    ['basura', 'basura'],
    ['ceros', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['mayúsculas', `00-${hex(16).toUpperCase()}-${hex(8).toUpperCase()}-01`],
    ['faltan campos', `00-${hex(16)}-01`],
    ['versión ff', `ff-${hex(16)}-${hex(8)}-01`],
    ['traceId corto', `00-${hex(8)}-${hex(8)}-01`],
    ['larguísimo', `00-${'a'.repeat(5000)}`],
  ])('INVÁLIDO: traceparent %s ⇒ 200 (nunca 5xx), traza NUEVA y reenviado bien formado de esa traza', async (_name, bad) => {
    const res = await call({ traceparent: bad });
    expect(res.status).toBe(200);
    const m = W3C.exec(forwarded().traceparent as string)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(serverSpan().spanContext().traceId);
    expect(m[1]).not.toMatch(/^0+$/);
    expect(parentIdOf(serverSpan())).toBeUndefined();
  });

  it('INVÁLIDO: destino caído ⇒ el borde responde 503 como siempre, con el span cliente en ERROR y la traza intacta', async () => {
    h.doubles['pay-ledger'].override = () => 'destroy';
    try {
      const res = await call({ 'x-request-id': 'id-correlacion-caido' });
      expect(res.status).toBeGreaterThanOrEqual(502);
      expect(res.status).toBeLessThanOrEqual(504);
      expect(res.headers['x-request-id']).toBe('id-correlacion-caido');
      expect(clientSpan().status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      h.doubles['pay-ledger'].override = undefined;
    }
  });

  it('SEGURIDAD: ningún span exportado lleva la clave de API ni el idempotency-key', async () => {
    await call();
    const dump = JSON.stringify(exported.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events, n: s.name })));
    expect(dump).not.toContain(auth.replace('Bearer ', ''));
    expect(dump).not.toContain(KEY);
  });
});
