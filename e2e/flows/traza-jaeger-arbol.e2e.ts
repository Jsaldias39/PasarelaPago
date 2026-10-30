import { existsSync, readFileSync } from 'node:fs';
import { publicApi } from '../lib/flow.ts';
import { danglingParents, Jaeger, reachableFrom, renderTree, serverSpanOf, servicesOf, viewsOf } from '../lib/jaeger.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { hasEdgeAndPayments, nowUs, otelEnvOverrides, qrIntent, randomSpanId, randomTraceId, TraceProbe } from '../lib/trace-probe.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * P1.H2.M3 (ola 5): el CONTRATO de la traza completa borde → pay-payments → (pay-risk | pay-connectors | pay-qr), contra el Jaeger REAL del Compose y tal como lo pide el DoD
 * de la fila («La traza en Jaeger cruza borde → servicio»). Nació en `pending/` en rojo a propósito (causas en los servicios: docs/trabajo/ola-5/P1/PROPUESTAS-TRAZA.md) y
 * pasó a `flows/` con sus aserciones SIN cambios cuando los servicios propagaron el contexto (pay-edge, pay-payments, pay-connectors). Lo que ya era verdad desde antes está
 * afirmado en traza-jaeger.e2e.ts.
 */
describe('árbol completo de la traza en Jaeger (borde → pay-payments → riesgo / conector)', () => {
  const jaeger = new Jaeger();
  let stack: Stack;
  let merchant: SeededMerchant;
  let probe: TraceProbe;
  let startUs: number;
  let api: ReturnType<typeof publicApi>;

  beforeAll(async () => {
    await jaeger.assertReachable();
    startUs = nowUs() - 5_000_000;
    stack = await startStack({ tolerateFailures: false, envOverrides: otelEnvOverrides(jaeger) });
    merchant = await seedMerchant(stack, { label: 'COMERCIO TRAZA PENDIENTE (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    probe = new TraceProbe(stack, merchant, jaeger);
    api = publicApi(stack, merchant);
  }, 600_000);
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  /** Líneas de acceso (`req.id`, `req.url`) de un servicio. */
  const accessLines = (service: 'pay-risk' | 'pay-connectors' | 'pay-qr'): { id: string; url: string }[] => {
    const file = stack.services[service].logFile;
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try {
        const o = JSON.parse(line) as { req?: { id?: string; url?: string } };
        return o.req?.id && o.req.url ? [{ id: o.req.id, url: o.req.url }] : [];
      } catch {
        return [];
      }
    });
  };

  const traceId = randomTraceId();
  const clientSpan = randomSpanId();
  let requestId: string;
  let intentId: string;

  it('borde → pay-payments: el span servidor de pay-payments CUELGA de un span del borde que está en la traza (no de un span-id que nadie exportó)', async () => {
    requestId = `traza-pend-${probe.runTag}`;
    const sent = await probe.send('arbol', { traceparent: `00-${traceId}-${clientSpan}-01`, requestId, json: qrIntent() });
    expect(sent.res.status).toBe(201);
    intentId = (sent.res.json as { id: string }).id;
    const trace = await probe.traceOf('árbol', sent, hasEdgeAndPayments);
    const views = viewsOf(trace);
    const payments = serverSpanOf(views, 'pay-payments')!;
    const parent = views.find((v) => v.spanId === payments.parentId);
    expect({ parentPresent: parent !== undefined, parentService: parent?.service }).toEqual({ parentPresent: true, parentService: 'pay-edge' });
  });

  it('SIN traceparent entrante, el borde y pay-payments quedan en la MISMA traza (una sola traza por petición)', async () => {
    const sent = await probe.send('sin-traceparent-arbol', { json: qrIntent() });
    expect(sent.res.status).toBe(201);
    const edgeTrace = await probe.traceOf('sin traceparent', sent);
    const counterpart = await probe.paymentsCounterpart(edgeTrace);
    expect(counterpart?.trace.traceID).toBe(edgeTrace.traceID);
  });

  it('la traza del cobro llega aguas abajo: contiene al menos un span servidor de pay-risk, pay-connectors o pay-qr', async () => {
    await api.settle(intentId); // el cobro ya llamó a riesgo y al conector (desde Temporal)
    await until('Jaeger tiene spans servidor de pay-risk de este cobro', async () => jaeger.search({ service: 'pay-risk', startUs, endUs: nowUs() + 600_000_000, limit: 200 }), (traces) => traces.some((t) => viewsOf(t).some((v) => v.kind === 'server' && v.operation === 'POST /assessments')), 60_000, 500);
    const trace = (await jaeger.trace(traceId))!;
    const downstream = servicesOf(viewsOf(trace)).filter((s) => ['pay-risk', 'pay-connectors', 'pay-qr'].includes(s));
    expect(downstream.length).toBeGreaterThan(0);
  });

  it('el x-request-id del cliente llega a pay-risk (o pay-connectors) en los logs, no un UUID nuevo por llamada', async () => {
    await until('pay-risk registró alguna evaluación', async () => accessLines('pay-risk'), (lines) => lines.some((l) => l.url.startsWith('/assessments')), 60_000, 300);
    const carrying = (['pay-risk', 'pay-connectors'] as const).filter((s) => accessLines(s).some((l) => l.id === requestId));
    expect(carrying.length).toBeGreaterThan(0);
  });

  // Se AGREGA (no se cambia ninguna aserción de arriba): el DoD pide el ÁRBOL, y «hay un span de pay-risk en la traza» no prueba que cuelgue de algo.
  it('el árbol de la traza del cobro no tiene padres ausentes (salvo el span del cliente): TODO span cuelga, directa o indirectamente, del span servidor del borde', async () => {
    const trace = await until(
      'Jaeger tiene la traza completa del cobro (borde, pay-payments, pay-risk y pay-connectors) sin padres ausentes',
      async () => jaeger.trace(traceId),
      (t) => {
        if (!t) return false;
        const views = viewsOf(t);
        const services = servicesOf(views);
        return ['pay-edge', 'pay-payments', 'pay-risk', 'pay-connectors'].every((s) => services.includes(s)) && danglingParents(views).length <= 1;
      },
      90_000,
      700,
    );
    const views = viewsOf(trace!);
    process.stdout.write(`ÁRBOL DEL COBRO ${traceId} (span del cliente ${clientSpan}; servicios: ${servicesOf(views).join(', ')}; ${views.length} spans):\n${renderTree(views)}\n`);
    expect(danglingParents(views).map((d) => ({ service: d.service, parentId: d.parentId }))).toEqual([{ service: 'pay-edge', parentId: clientSpan }]);
    const edge = serverSpanOf(views, 'pay-edge')!;
    const reachable = reachableFrom(views, edge.spanId);
    expect(views.filter((v) => !reachable.has(v.spanId)).map((v) => `${v.service}:${v.operation}`)).toEqual([]);
  });
});
