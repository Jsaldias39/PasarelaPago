import { Jaeger, contentTextOf, danglingParents, reachableFrom, renderTree, serverSpanOf, servicesOf, textOf, viewsOf, type JaegerTrace } from '../lib/jaeger.ts';
import { scanSources, SYNTHETIC_PANS } from '../lib/pan-scan.ts';
import { SYNTHETIC_PAYER_NAME, seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { ALL_SERVICES } from '../lib/services.ts';
import { hasEdgeAndPayments, nowUs, otelEnvOverrides, qrIntent as qr, randomSpanId, randomTraceId, TraceProbe } from '../lib/trace-probe.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * Traza REAL en Jaeger (P1.H2.M3, ola 5): los servicios del arnés exportan OTLP/HTTP al contenedor `pay-jaeger-1` del Compose (no a un colector del arnés) y la prueba
 * LEE la traza de la API de consulta de Jaeger. Se hace un cobro por la API pública de pay-edge con un `traceparent` y un `x-request-id` de la prueba.
 *
 * QUÉ AFIRMA (lo que hoy es verdad, medido): con un `traceparent` válido del cliente, la traza se CONTINÚA en el borde (su span servidor cuelga del span del cliente) y
 * pay-payments cae en la MISMA traza; el `x-request-id` llega igual a los logs de ambos; un `traceparent` malformado o ausente origina una traza nueva sin romper la petición
 * (nunca 5xx); y ningún span (de ningún servicio) lleva la clave de API, el cuerpo de la petición ni un PAN.
 *
 * QUÉ NO AFIRMA, porque hoy NO es verdad y arreglarlo es de otros carriles (medido y proyectado a texto por esta prueba, afirmado en pending/traza-jaeger-arbol.e2e.ts, razonado
 * en docs/trabajo/ola-5/P1/PROPUESTAS-TRAZA.md): (1) que el span de pay-payments cuelgue de un span del borde (el borde fabrica el span-id del `traceparent` que reenvía y ningún
 * span lo tiene: padre ausente); (2) que, SIN `traceparent` entrante, pay-payments caiga en la traza del borde (el borde reenvía un traceId nuevo, distinto del de su propia traza);
 * (3) que la traza llegue a pay-risk / pay-connectors / pay-qr (pay-payments los llama desde actividades de Temporal sin contexto, su cliente HTTP no manda `traceparent` y cambia
 * el `x-request-id`).
 *
 * Sin sleep fijo: se espera por condición a que Jaeger indexe (lote del SDK + indexación). Datos sintéticos; la prueba no usa PAN reales.
 */
const CANARY = 'traza-canary-marcador-no-pan';
const PROBE_PAN = SYNTHETIC_PANS.visa;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

describe('Traza real en Jaeger — borde → servicio con traceparent y request_id', () => {
  const jaeger = new Jaeger();
  let stack: Stack;
  let merchant: SeededMerchant;
  let probe: TraceProbe;
  let runUs: number;

  beforeAll(async () => {
    await jaeger.assertReachable();
    runUs = nowUs() - 5_000_000;
    stack = await startStack({ tolerateFailures: false, envOverrides: otelEnvOverrides(jaeger) });
    merchant = await seedMerchant(stack, { label: 'COMERCIO TRAZA (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    probe = new TraceProbe(stack, merchant, jaeger);
  }, 600_000);
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('CORRECTO: el traceparent del cliente se continúa en el borde, pay-payments cae en la MISMA traza y el request_id llega igual a los logs de ambos', async () => {
    const traceId = randomTraceId();
    const clientSpan = randomSpanId();
    const requestId = `traza-ok-${probe.runTag}`;
    const sent = await probe.send('correcto', { traceparent: `00-${traceId}-${clientSpan}-01`, requestId, json: qr({ description: CANARY, metadata: { marcador: CANARY }, payer_name: SYNTHETIC_PAYER_NAME }) });
    expect(sent.res.status).toBe(201);
    expect(sent.res.headers.get('x-request-id')).toBe(requestId);

    const trace = await probe.traceOf('correcto', sent, hasEdgeAndPayments);
    const views = viewsOf(trace);
    expect(trace.traceID).toBe(traceId); // la traza del cliente se continuó: el traceId es el suyo
    expect(servicesOf(views)).toEqual(expect.arrayContaining(['pay-edge', 'pay-payments']));

    // Relación padre/hijo EN el borde: su span servidor cuelga del span del cliente, y todos sus demás spans cuelgan (transitivamente) de él.
    const edgeServer = serverSpanOf(views, 'pay-edge')!;
    expect(edgeServer.parentId).toBe(clientSpan);
    expect(edgeServer.attrs['http.route']).toBe('/v1/:x');
    const underEdge = reachableFrom(views, edgeServer.spanId);
    expect(views.filter((v) => v.service === 'pay-edge' && !underEdge.has(v.spanId)).map((v) => v.operation)).toEqual([]);

    // Borde → servicio: el span servidor de pay-payments es de la misma traza y NO es una raíz (recibió un traceparent con un span padre), y los spans de pay-payments
    // cuelgan de él (salvo los que ya estaban sueltos por otra causa: ninguno hoy).
    const paymentsServer = serverSpanOf(views, 'pay-payments')!;
    expect(paymentsServer.operation).toBe('POST /payment_intents');
    expect(paymentsServer.parentId).toMatch(/^[0-9a-f]{16}$/);
    const underPayments = reachableFrom(views, paymentsServer.spanId);
    expect(views.filter((v) => v.service === 'pay-payments' && !underPayments.has(v.spanId)).map((v) => v.operation)).toEqual([]);

    // request_id: el mismo en el borde y en pay-payments.
    await probe.logsCarry(requestId, ['pay-edge', 'pay-payments']);

    process.stdout.write(`TRAZA ${traceId} (continuada del cliente, span del cliente ${clientSpan}):\n${renderTree(views)}\npadres ausentes de la traza: ${danglingParents(views).map((d) => `${d.service}:${d.operation}→${d.parentId}`).join(', ') || 'ninguno'}\n`);
  });

  it('LÍMITE: un traceparent MALFORMADO no rompe la petición: 201, request_id propio y una traza NUEVA (raíz sin padre, traceId distinto del recibido)', async () => {
    const t = randomTraceId();
    const p = randomSpanId();
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
      const sent = await probe.send(`malformado-${label.replace(/\W+/g, '_')}`, { traceparent: value, json: qr() });
      expect([label, sent.res.status]).toEqual([label, 201]);
      const requestId = sent.res.headers.get('x-request-id');
      expect(requestId).toMatch(UUID); // sin x-request-id del cliente: el borde abre uno
      const trace = await probe.traceOf(label, sent);
      const views = viewsOf(trace);
      expect([label, trace.traceID]).toEqual([label, expect.stringMatching(HEX32)]);
      expect(trace.traceID).not.toBe('0'.repeat(32));
      if (embedded) expect(trace.traceID).not.toBe(embedded);
      expect([label, serverSpanOf(views, 'pay-edge')!.parentId]).toEqual([label, undefined]); // raíz: no hereda nada del valor malformado
      await probe.logsCarry(requestId!, ['pay-edge', 'pay-payments']);
    }
  });

  it('LÍMITE: un traceparent de una versión FUTURA (01, con campo extra) no rompe la petición y el borde exporta su traza', async () => {
    const t = randomTraceId();
    const p = randomSpanId();
    const sent = await probe.send('version-futura', { traceparent: `01-${t}-${p}-01-campo-extra`, json: qr() });
    expect(sent.res.status).toBe(201);
    const trace = await probe.traceOf('versión futura', sent);
    const edge = serverSpanOf(viewsOf(trace), 'pay-edge')!;
    expect(edge).toBeDefined();
    // Lo que se MIDE (no se afirma): el SDK acepta versiones futuras (W3C) pero el borde solo reconoce `00-`.
    process.stdout.write(`MEDIDO traceparent de versión futura: el borde ${trace.traceID === t ? 'CONTINÚA la traza del cliente' : 'abre una traza nueva'} (span padre ${edge.parentId ?? 'ninguno'}).\n`);
  });

  it('INVÁLIDO: sin traceparent y sin x-request-id (o con uno mal formado) ⇒ traza nueva y request_id nuevo, nunca 5xx; el request_id nuevo llega a los logs de borde y servicio', async () => {
    for (const [label, requestId] of [['ausente', undefined], ['corto', 'x'], ['con espacios y símbolos', 'esto no es un id válido!']] as const) {
      const sent = await probe.send(`sin-traceparent-${label.replace(/\W+/g, '_')}`, { json: qr(), ...(requestId !== undefined ? { requestId } : {}) });
      expect([label, sent.res.status]).toEqual([label, 201]);
      const issued = sent.res.headers.get('x-request-id')!;
      expect(issued).toMatch(UUID);
      if (requestId) expect(issued).not.toBe(requestId);
      const trace = await probe.traceOf(label, sent);
      const views = viewsOf(trace);
      expect(trace.traceID).toMatch(HEX32);
      expect([label, serverSpanOf(views, 'pay-edge')!.parentId]).toEqual([label, undefined]);
      await probe.logsCarry(issued, ['pay-edge', 'pay-payments']);
      if (label === 'ausente') {
        // Lo que se MIDE (no se afirma; el contrato está en e2e/pending/traza-jaeger-arbol.e2e.ts): dónde cae el span de pay-payments de ESTA misma petición.
        const counterpart = await probe.paymentsCounterpart(trace);
        process.stdout.write(`MEDIDO sin traceparent: traza del borde ${trace.traceID}; span de pay-payments de la misma petición en la traza ${counterpart?.trace.traceID} (${counterpart?.trace.traceID === trace.traceID ? 'LA MISMA' : 'OTRA: la traza queda partida en dos'}).\n`);
      }
    }
  });

  it('INVÁLIDO: una petición rechazada por el borde (JSON roto) con traceparent no es 5xx, el problem lleva el request_id del cliente y la traza existe con el span del borde', async () => {
    const traceId = randomTraceId();
    const clientSpan = randomSpanId();
    const requestId = `traza-err-${probe.runTag}`;
    const sent = await probe.send('rechazada', { traceparent: `00-${traceId}-${clientSpan}-01`, requestId, body: '{"amount_minor": ' });
    expect(sent.res.status).toBeGreaterThanOrEqual(400);
    expect(sent.res.status).toBeLessThan(500);
    expect((sent.res.json as { request_id?: string }).request_id).toBe(requestId);
    const trace = await probe.traceOf('rechazada', sent);
    const views = viewsOf(trace);
    expect(trace.traceID).toBe(traceId);
    expect(serverSpanOf(views, 'pay-edge')!.parentId).toBe(clientSpan);
    expect(servicesOf(views)).not.toContain('pay-payments'); // el borde cortó antes de reenviar
    await probe.logsCarry(requestId, ['pay-edge']);
  });

  it('SEGURIDAD: ningún span de ningún servicio lleva la clave de API, el cuerpo de la petición ni un PAN (se escanea lo que Jaeger devuelve)', async () => {
    // Una sonda con un PAN sintético en la ruta y en la query: las instrumentaciones copian ambas a sus spans y el exportador las tiene que enmascarar.
    const sent = await probe.send('sonda-pan', { method: 'GET', path: `/v1/payment_intents/${PROBE_PAN}?card=${PROBE_PAN}&documento=${PROBE_PAN}` });
    expect(sent.res.status).toBeLessThan(500);
    const probeEdge = serverSpanOf(viewsOf(await probe.traceOf('sonda con PAN', sent)), 'pay-edge')!;
    expect(JSON.stringify(probeEdge.attrs)).not.toContain(PROBE_PAN);
    process.stdout.write(`SONDA con PAN en ruta y query: el span servidor del borde dejó url.path=${String(probeEdge.attrs['url.path'])} url.query=${String(probeEdge.attrs['url.query'])} http.route=${String(probeEdge.attrs['http.route'])}\n`);

    // Todo lo que los servicios exportaron durante esta corrida (no solo las trazas de arriba: también las que nacen aguas abajo).
    const all = new Map<string, JaegerTrace>(probe.seen);
    for (const service of ALL_SERVICES) for (const t of await jaeger.search({ service, startUs: runUs, endUs: nowUs() + 600_000_000, limit: 1000 })) all.set(t.traceID, t);
    const traces = [...all.values()];
    const spanCount = traces.reduce((n, t) => n + t.spans.length, 0);
    expect(spanCount).toBeGreaterThan(50); // el escaneo no puede ser vacío
    expect([...probe.seen.keys()].filter((id) => !all.has(id))).toEqual([]);

    const secret = merchant.token.replace(/^sk_test_/, '');
    expect(secret.length).toBeGreaterThan(16);
    const sources = traces.map((t) => ({ source: `traza:${t.traceID}`, text: textOf(t) }));
    const forbidden: [string, string][] = [['la clave de API completa', merchant.token], ['el secreto de la clave de API', secret], ['el marcador del cuerpo', CANARY], ['el nombre del pagador del cuerpo', SYNTHETIC_PAYER_NAME]];
    for (const [what, needle] of forbidden) expect([what, sources.filter((s) => s.text.includes(needle)).map((s) => s.source)]).toEqual([what, []]);
    // El detector de PAN mira el contenido sin identificadores ni tiempos (un trace-id hex trae tiras de dígitos que pasan Luhn por azar; ver contentTextOf).
    const scan = scanSources(traces.map((t) => ({ source: `traza:${t.traceID}`, text: contentTextOf(t) })), Object.values(SYNTHETIC_PANS));
    expect(scan.hits).toEqual([]);

    // Lo MEDIDO aguas abajo (se imprime, no se afirma): ver e2e/pending/traza-jaeger-arbol.e2e.ts y PROPUESTAS-TRAZA.md.
    const downstream = ['pay-risk', 'pay-connectors', 'pay-qr', 'pay-ledger', 'pay-vault'].map((service) => {
      const roots = new Map<string, number>();
      let inEdgeTrace = 0;
      for (const t of traces) {
        const views = viewsOf(t);
        if (views.some((v) => v.service === service) && servicesOf(views).includes('pay-edge')) inEdgeTrace += 1;
        for (const v of views) if (v.service === service && v.kind === 'server' && !/health/.test(v.operation)) roots.set(v.operation, (roots.get(v.operation) ?? 0) + 1);
      }
      return `${service}: spans servidor de negocio ${JSON.stringify(Object.fromEntries(roots))}, en trazas que contienen a pay-edge: ${inEdgeTrace}`;
    });
    process.stdout.write(`ESCANEO DE FUGAS: ${traces.length} trazas, ${spanCount} spans, ${scan.bytes} bytes; 0 apariciones de clave de API, cuerpo ni PAN.\nMEDIDO aguas abajo (sin afirmar):\n  ${downstream.join('\n  ')}\n`);
  });
});
