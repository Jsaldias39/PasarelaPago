import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Jaeger, reachableFrom, renderTree, danglingParents, serverSpanOf, servicesOf, textOf, viewsOf, type JaegerTrace } from '../lib/jaeger.ts';
import { scanSources, SYNTHETIC_PANS } from '../lib/pan-scan.ts';
import { SYNTHETIC_PAYER_NAME, seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { ALL_SERVICES, type ServiceName } from '../lib/services.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type HttpResult, type Stack } from '../stack.ts';

/**
 * Traza REAL en Jaeger (P1.H2.M3, ola 5): los servicios del arnés exportan OTLP/HTTP al contenedor `pay-jaeger-1` del Compose (no a un colector del arnés) y la prueba
 * LEE la traza de la API de consulta de Jaeger. Se hace un cobro por la API pública de pay-edge con un `traceparent` y un `x-request-id` de la prueba.
 *
 * QUÉ AFIRMA (lo que hoy es verdad, medido): la traza del cliente se CONTINÚA en el borde (el span servidor de pay-edge cuelga del span del cliente), pay-payments cae en la MISMA
 * traza (borde → servicio por traceId), el `x-request-id` llega igual a los logs de ambos, un `traceparent` malformado u ausente origina una traza nueva sin romper la petición y
 * ningún span (de ningún servicio) lleva la clave de API, el cuerpo de la petición ni un PAN.
 *
 * QUÉ NO AFIRMA, porque hoy NO es verdad y arreglarlo es de otros carriles: que el span de pay-payments cuelgue de un span del borde (el borde fabrica el span-id del
 * `traceparent` que reenvía y ningún span lo tiene: padre ausente), ni que la traza llegue a pay-risk / pay-connectors / pay-qr (pay-payments los llama desde actividades de
 * Temporal sin contexto y su cliente HTTP no manda `traceparent` y cambia el `x-request-id`). Eso está escrito contra el contrato en e2e/pending/traza-jaeger-arbol.e2e.ts
 * y razonado en docs/trabajo/ola-5/P1/PROPUESTAS-TRAZA.md. Lo MEDIDO se imprime (árbol de spans y servicios aguas abajo) pero no se afirma.
 *
 * Sin sleep fijo: se espera por condición a que Jaeger indexe (retraso del lote del SDK + indexación). Datos sintéticos; la prueba no usa PAN reales.
 */
const CANARY = 'traza-canary-marcador-no-pan';
const PROBE_PAN = SYNTHETIC_PANS.visa;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

describe('Traza real en Jaeger — borde → servicio con traceparent y request_id', () => {
  const jaeger = new Jaeger();
  let stack: Stack;
  let merchant: SeededMerchant;
  let runUs: number;
  let runTag: string;
  let counter = 0;
  const seen = new Map<string, JaegerTrace>();

  const nowUs = (): number => Date.now() * 1000;

  /** Un cobro QR (o la petición que se pida) por la API pública; el user-agent único permite hallar su traza en Jaeger sin conocer el traceId. */
  async function send(label: string, init: { traceparent?: string; requestId?: string; method?: string; path?: string; json?: unknown; body?: string } = {}): Promise<{ res: HttpResult; ua: string; sinceUs: number }> {
    counter += 1;
    const ua = `e2e-traza/${runTag}/${label}`;
    const sinceUs = nowUs() - 2_000_000;
    const method = init.method ?? 'POST';
    const headers: Record<string, string> = {
      authorization: `Bearer ${merchant.token}`,
      'user-agent': ua,
      ...(method === 'POST' ? { 'idempotency-key': `traza-${runTag}-${String(counter).padStart(3, '0')}` } : {}),
      ...(init.traceparent !== undefined ? { traceparent: init.traceparent } : {}),
      ...(init.requestId !== undefined ? { 'x-request-id': init.requestId } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const res = await stack.call('pay-edge', method, init.path ?? '/v1/payment_intents', { headers, ...(init.json !== undefined ? { json: init.json } : {}), ...(init.body !== undefined ? { body: init.body } : {}), timeoutMs: 30_000 });
    return { res, ua, sinceUs };
  }

  /** Espera (por condición) a que Jaeger tenga la traza del user-agent con lo que `ready` pida, y a que deje de crecer (dos lecturas con el mismo número de spans). */
  async function traceOf(label: string, ua: string, sinceUs: number, ready: (views: ReturnType<typeof viewsOf>) => boolean): Promise<JaegerTrace> {
    const first = await until(
      `Jaeger indexa la traza de «${label}»`,
      async () => (await jaeger.search({ service: 'pay-edge', tags: { 'user_agent.original': ua }, startUs: sinceUs, endUs: nowUs() + 600_000_000 })).find((t) => ready(viewsOf(t))),
      (t) => t !== undefined,
      90_000,
      500,
    );
    let previous = -1;
    const settled = await until(
      `la traza de «${label}» deja de crecer`,
      async () => {
        const t = (await jaeger.trace(first!.traceID)) ?? first!;
        const grew = t.spans.length !== previous;
        previous = t.spans.length;
        return { t, grew };
      },
      (r) => !r.grew,
      30_000,
      600,
    );
    seen.set(settled.t.traceID, settled.t);
    return settled.t;
  }

  /** ¿Hay en el log del servicio una línea de acceso con ESTE id de petición? (los logs son JSON de pino: `req.id`). */
  const hasAccessLog = (service: ServiceName, requestId: string): boolean => {
    const file = stack.services[service].logFile;
    if (!existsSync(file)) return false;
    return readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => {
        if (!line.includes(requestId)) return false;
        try {
          return (JSON.parse(line) as { req?: { id?: string } }).req?.id === requestId;
        } catch {
          return false;
        }
      });
  };
  const logsCarry = (requestId: string, services: readonly ServiceName[]) => until(`los logs de ${services.join(' y ')} llevan el request_id ${requestId}`, async () => services.map((s) => hasAccessLog(s, requestId)), (r) => r.every(Boolean), 30_000, 300);

  const qr = (extra: Record<string, unknown> = {}) => ({ amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' }, ...extra });
  const bothServices = (views: ReturnType<typeof viewsOf>): boolean => serverSpanOf(views, 'pay-edge') !== undefined && serverSpanOf(views, 'pay-payments') !== undefined;

  beforeAll(async () => {
    await jaeger.assertReachable();
    runTag = randomBytes(4).toString('hex');
    runUs = nowUs() - 5_000_000;
    // Único ajuste del ENTORNO del arnés: dónde exporta cada servicio sus trazas (Jaeger del Compose) y un lote corto para no esperar el de 5 s del SDK.
    const otel = { OTEL_EXPORTER_OTLP_ENDPOINT: jaeger.endpoints.otlpUrl, OTEL_BSP_SCHEDULE_DELAY: '300' };
    stack = await startStack({ tolerateFailures: false, envOverrides: Object.fromEntries(ALL_SERVICES.map((name) => [name, otel])) });
    merchant = await seedMerchant(stack, { label: 'COMERCIO TRAZA (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
  }, 600_000);
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('CORRECTO: el traceparent del cliente se continúa en el borde, pay-payments cae en la MISMA traza y el request_id llega igual a los logs de ambos', async () => {
    const traceId = randomBytes(16).toString('hex');
    const clientSpan = randomBytes(8).toString('hex');
    const requestId = `traza-ok-${runTag}`;
    const { res, ua, sinceUs } = await send('correcto', { traceparent: `00-${traceId}-${clientSpan}-01`, requestId, json: qr({ description: CANARY, metadata: { marcador: CANARY }, payer_name: SYNTHETIC_PAYER_NAME }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe(requestId);

    const trace = await traceOf('correcto', ua, sinceUs, bothServices);
    const views = viewsOf(trace);
    expect(trace.traceID).toBe(traceId); // la traza del cliente se continuó: el traceId es el suyo
    expect(servicesOf(views)).toEqual(expect.arrayContaining(['pay-edge', 'pay-payments']));

    // Relación padre/hijo EN el borde: su span servidor cuelga del span del cliente, y todos sus demás spans cuelgan (transitivamente) de él.
    const edgeServer = serverSpanOf(views, 'pay-edge')!;
    expect(edgeServer.parentId).toBe(clientSpan);
    expect(edgeServer.attrs['http.route']).toBe('/v1/:x');
    const underEdge = reachableFrom(views, edgeServer.spanId);
    expect(views.filter((v) => v.service === 'pay-edge' && !underEdge.has(v.spanId)).map((v) => v.operation)).toEqual([]);

    // Borde → servicio: el span servidor de pay-payments es de la misma traza y NO es una raíz (recibió un traceparent con un span padre).
    const paymentsServer = serverSpanOf(views, 'pay-payments')!;
    expect(paymentsServer.operation).toBe('POST /payment_intents');
    expect(paymentsServer.parentId).toMatch(/^[0-9a-f]{16}$/);
    const underPayments = reachableFrom(views, paymentsServer.spanId);
    expect(views.filter((v) => v.service === 'pay-payments' && !underPayments.has(v.spanId) && v.parentId !== undefined && views.some((p) => p.spanId === v.parentId)).map((v) => v.operation)).toEqual([]);

    // request_id: el mismo en el borde y en pay-payments.
    await logsCarry(requestId, ['pay-edge', 'pay-payments']);

    process.stdout.write(`TRAZA ${traceId} (continuada del cliente, span del cliente ${clientSpan}):\n${renderTree(views)}\npadres ausentes: ${danglingParents(views).map((d) => `${d.service}:${d.operation}→${d.parentId}`).join(', ') || 'ninguno'}\n`);
  });

  it('LÍMITE: un traceparent MALFORMADO no rompe la petición: 201, request_id propio y una traza NUEVA (raíz sin padre, traceId distinto del recibido)', async () => {
    const t = randomBytes(16).toString('hex');
    const p = randomBytes(8).toString('hex');
    const malformed: [string, string, string | undefined][] = [
      ['versión ff', `ff-${t}-${p}-01`, t],
      ['hex en mayúsculas', `00-${t.toUpperCase()}-${p}-01`, t],
      ['traceId todo ceros', `00-${'0'.repeat(32)}-${p}-01`, undefined],
      ['span-id todo ceros', `00-${t}-${'0'.repeat(16)}-01`, t],
      ['demasiado corto', '00-abc-def-01', undefined],
      ['basura', 'esto-no-es-un-traceparent', undefined],
      ['versión 00 con campo extra', `00-${t}-${p}-01-extra`, t],
    ];
    for (const [label, value, embedded] of malformed) {
      const { res, ua, sinceUs } = await send(`malformado-${label.replace(/\W+/g, '_')}`, { traceparent: value, json: qr() });
      expect([label, res.status]).toEqual([label, 201]);
      const requestId = res.headers.get('x-request-id');
      expect(requestId).toMatch(UUID); // sin x-request-id del cliente: el borde abre uno
      const trace = await traceOf(label, ua, sinceUs, bothServices);
      const views = viewsOf(trace);
      expect([label, trace.traceID]).toEqual([label, expect.stringMatching(HEX32)]);
      expect(trace.traceID).not.toBe('0'.repeat(32));
      if (embedded) expect(trace.traceID).not.toBe(embedded);
      expect([label, serverSpanOf(views, 'pay-edge')!.parentId]).toEqual([label, undefined]); // raíz: no hereda nada del valor malformado
      await logsCarry(requestId!, ['pay-edge', 'pay-payments']);
    }
  });

  it('LÍMITE: un traceparent válido de una versión FUTURA (01, con campo extra) tampoco rompe la petición y deja UNA traza que contiene al borde y a pay-payments', async () => {
    const t = randomBytes(16).toString('hex');
    const p = randomBytes(8).toString('hex');
    const { res, ua, sinceUs } = await send('version-futura', { traceparent: `01-${t}-${p}-01-campo-extra`, json: qr() });
    expect(res.status).toBe(201);
    // El SDK de OpenTelemetry acepta versiones futuras (W3C: un parser ignora los campos que no conoce) pero el borde solo reconoce `00-`. Lo que se afirma es lo que debe
    // valer sea cual sea la política: la petición no se rompe y el borde y pay-payments terminan en una sola traza (si no, la traza queda partida en dos).
    const trace = await traceOf('versión futura', ua, sinceUs, (v) => serverSpanOf(v, 'pay-edge') !== undefined);
    const views = viewsOf(trace);
    expect(serverSpanOf(views, 'pay-edge')).toBeDefined();
    const found = await until('pay-payments aparece en la misma traza que el borde', async () => viewsOf((await jaeger.trace(trace.traceID))!), (v) => serverSpanOf(v, 'pay-payments') !== undefined, 30_000, 500).catch(() => undefined);
    process.stdout.write(`TRAZA con traceparent de versión futura ${trace.traceID}: ${found ? 'pay-edge y pay-payments en la misma traza' : 'PARTIDA: pay-payments NO está en la traza del borde'}\n`);
    expect(found).toBeDefined();
  });

  it('INVÁLIDO: sin traceparent y sin x-request-id (o con uno mal formado) ⇒ traza nueva y request_id nuevo, nunca 5xx; el request_id nuevo llega a los logs de borde y servicio', async () => {
    for (const [label, requestId] of [['ausente', undefined], ['corto', 'x'], ['con espacios y símbolos', 'esto no es un id válido!']] as const) {
      const { res, ua, sinceUs } = await send(`sin-traceparent-${label.replace(/\W+/g, '_')}`, { json: qr(), ...(requestId !== undefined ? { requestId } : {}) });
      expect([label, res.status]).toEqual([label, 201]);
      const issued = res.headers.get('x-request-id')!;
      expect(issued).toMatch(UUID);
      if (requestId) expect(issued).not.toBe(requestId);
      const trace = await traceOf(label, ua, sinceUs, bothServices);
      const views = viewsOf(trace);
      expect(trace.traceID).toMatch(HEX32);
      expect([label, serverSpanOf(views, 'pay-edge')!.parentId]).toEqual([label, undefined]);
      await logsCarry(issued, ['pay-edge', 'pay-payments']);
    }
  });

  it('INVÁLIDO: una petición rechazada por el borde (JSON roto) con traceparent no es 5xx, el problem lleva el request_id del cliente y la traza existe con el span del borde', async () => {
    const traceId = randomBytes(16).toString('hex');
    const clientSpan = randomBytes(8).toString('hex');
    const requestId = `traza-err-${runTag}`;
    const { res, ua, sinceUs } = await send('rechazada', { traceparent: `00-${traceId}-${clientSpan}-01`, requestId, body: '{"amount_minor": ' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((res.json as { request_id?: string }).request_id).toBe(requestId);
    const trace = await traceOf('rechazada', ua, sinceUs, (v) => serverSpanOf(v, 'pay-edge') !== undefined);
    const views = viewsOf(trace);
    expect(trace.traceID).toBe(traceId);
    expect(serverSpanOf(views, 'pay-edge')!.parentId).toBe(clientSpan);
    expect(servicesOf(views)).not.toContain('pay-payments'); // el borde cortó antes de reenviar
    await logsCarry(requestId, ['pay-edge']);
  });

  it('SEGURIDAD: ningún span de ningún servicio lleva la clave de API, el cuerpo de la petición ni un PAN (se escanea lo que Jaeger devuelve)', async () => {
    // Una sonda con un PAN sintético en la ruta y en la query: las instrumentaciones copian ambas a sus spans y el exportador las tiene que enmascarar.
    const probe = await send('sonda-pan', { method: 'GET', path: `/v1/payment_intents/${PROBE_PAN}?card=${PROBE_PAN}&documento=${PROBE_PAN}` });
    expect(probe.res.status).toBeLessThan(500);
    const probeTrace = await traceOf('sonda con PAN', probe.ua, probe.sinceUs, (v) => serverSpanOf(v, 'pay-edge') !== undefined);
    const probeEdge = serverSpanOf(viewsOf(probeTrace), 'pay-edge')!;
    expect(String(probeEdge.attrs['url.query'] ?? probeEdge.attrs['http.target'] ?? '')).not.toContain(PROBE_PAN);

    // Todo lo que los 11 servicios exportaron durante esta corrida (no solo las trazas de arriba: también las que nacen aguas abajo).
    const all = new Map<string, JaegerTrace>(seen);
    for (const service of ALL_SERVICES) for (const t of await jaeger.search({ service, startUs: runUs, endUs: nowUs() + 600_000_000, limit: 200 })) all.set(t.traceID, t);
    const traces = [...all.values()];
    const spanCount = traces.reduce((n, t) => n + t.spans.length, 0);
    expect(spanCount).toBeGreaterThan(50); // el escaneo no puede ser vacío

    const secret = merchant.token.replace(/^sk_test_/, '');
    expect(secret.length).toBeGreaterThan(16);
    const sources = traces.map((t) => ({ source: `traza:${t.traceID}`, text: textOf(t) }));
    const forbidden: [string, string][] = [['la clave de API completa', merchant.token], ['el secreto de la clave de API', secret], ['el marcador del cuerpo', CANARY], ['el nombre del pagador del cuerpo', SYNTHETIC_PAYER_NAME]];
    for (const [what, needle] of forbidden) expect([what, sources.filter((s) => s.text.includes(needle)).map((s) => s.source)]).toEqual([what, []]);
    const scan = scanSources(sources, Object.values(SYNTHETIC_PANS));
    expect(scan.hits).toEqual([]);

    // Lo MEDIDO aguas abajo (se imprime, no se afirma): ver e2e/pending/traza-jaeger-arbol.e2e.ts y PROPUESTAS-TRAZA.md.
    const downstream = ['pay-risk', 'pay-connectors', 'pay-qr', 'pay-ledger', 'pay-vault'].map((service) => {
      const own = traces.filter((t) => t.spans.some((s) => t.processes[s.processID]?.serviceName === service && s.tags?.some((tag) => tag.key === 'span.kind' && tag.value === 'server') && !/health/.test(s.operationName)));
      const joinedEdgeTrace = own.filter((t) => servicesOf(viewsOf(t)).includes('pay-edge')).length;
      return `${service}: ${own.length} traza(s) con span servidor de negocio, ${joinedEdgeTrace} en una traza que contiene a pay-edge`;
    });
    process.stdout.write(`ESCANEO DE FUGAS: ${traces.length} trazas, ${spanCount} spans, ${scan.bytes} bytes; 0 apariciones de clave de API, cuerpo ni PAN.\nMEDIDO aguas abajo (sin afirmar): ${downstream.join(' | ')}\n`);
  });
});
