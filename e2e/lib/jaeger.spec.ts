import { contentTextOf, danglingParents, jaegerEndpoints, reachableFrom, renderTree, serverSpanOf, servicesOf, viewsOf, type JaegerSpan, type JaegerTrace } from './jaeger.ts';

/** Las funciones puras del cliente de Jaeger: correcto (árbol y alcanzabilidad), límite (padre ausente, varias raíces, ruido) e inválido (traza vacía, proceso desconocido, entorno). */
const span = (id: string, op: string, process: string, parent?: string, extra: Partial<JaegerSpan> = {}): JaegerSpan => ({
  traceID: 't'.repeat(32),
  spanID: id,
  operationName: op,
  references: parent ? [{ refType: 'CHILD_OF', traceID: 't'.repeat(32), spanID: parent }] : [],
  startTime: 1_000 + Number.parseInt(id, 16),
  duration: 10,
  tags: [],
  processID: process,
  ...extra,
});
const server = { tags: [{ key: 'span.kind', type: 'string', value: 'server' }, { key: 'http.route', type: 'string', value: '/x' }] };
const trace = (spans: JaegerSpan[]): JaegerTrace => ({ traceID: 't'.repeat(32), spans, processes: { p1: { serviceName: 'pay-edge' }, p2: { serviceName: 'pay-payments' } } });

describe('jaeger (funciones puras)', () => {
  it('CORRECTO: resuelve servicio, padre y atributos; el árbol borde → servicio con el puente completo no tiene padres ausentes', () => {
    const t = trace([span('01', 'POST /v1/*path', 'p1', undefined, server), span('02', 'handle', 'p1', '01'), span('03', 'POST /payments', 'p2', '02', server), span('04', 'create', 'p2', '03')]);
    const views = viewsOf(t);
    expect(servicesOf(views)).toEqual(['pay-edge', 'pay-payments']);
    expect(serverSpanOf(views, 'pay-payments')).toMatchObject({ spanId: '03', parentId: '02', attrs: { 'http.route': '/x' } });
    expect(danglingParents(views)).toEqual([]);
    expect([...reachableFrom(views, '01')].sort()).toEqual(['01', '02', '03', '04']);
    expect(renderTree(views).split('\n').map((l) => l.trim().split('  ')[0])).toEqual(['pay-edge', 'pay-edge', 'pay-payments', 'pay-payments']);
  });

  it('LÍMITE: un padre que nadie exportó se reporta como ausente y el árbol lo marca; la alcanzabilidad no cruza el hueco', () => {
    const t = trace([span('01', 'POST /v1/*path', 'p1', 'ff', server), span('03', 'POST /payments', 'p2', 'aa', server), span('04', 'create', 'p2', '03')]);
    const views = viewsOf(t);
    expect(danglingParents(views).map((v) => [v.spanId, v.parentId])).toEqual([['01', 'ff'], ['03', 'aa']]);
    expect([...reachableFrom(views, '01')]).toEqual(['01']);
    expect(renderTree(views)).toContain('[padre ausente de la traza: aa]');
  });

  it('LÍMITE: los spans de ruido (pg.*, middleware) se cuentan, no se listan', () => {
    const t = trace([span('01', 'POST /payments', 'p2', undefined, server), span('02', 'pg.query:SELECT pay_payments', 'p2', '01'), span('03', 'middleware - jsonParser', 'p2', '01')]);
    const text = renderTree(viewsOf(t));
    expect(text).toContain('2 span(s) de ruido');
    expect(text).not.toContain('pg.query');
  });

  it('INVÁLIDO: una traza sin spans, un span sin referencias o con un proceso desconocido no rompen nada', () => {
    expect(viewsOf(trace([]))).toEqual([]);
    expect(renderTree([])).toBe('');
    const [orphan] = viewsOf(trace([span('09', 'x', 'p9')]));
    expect(orphan).toMatchObject({ service: '?p9', parentId: undefined, kind: undefined });
    expect(serverSpanOf([orphan!], 'pay-edge')).toBeUndefined();
  });

  it('CORRECTO / INVÁLIDO: los endpoints salen de los puertos publicados del Compose y se pueden sobrescribir por entorno', () => {
    expect(jaegerEndpoints({})).toEqual({ queryUrl: 'http://127.0.0.1:54686', otlpUrl: 'http://127.0.0.1:54318' });
    expect(jaegerEndpoints({ PAY_E2E_JAEGER_QUERY_URL: 'http://x:1', PAY_E2E_JAEGER_OTLP_URL: 'http://x:2' })).toEqual({ queryUrl: 'http://x:1', otlpUrl: 'http://x:2' });
  });
});

describe('contentTextOf', () => {
  it('LÍMITE: quita identificadores y tiempos (que pasan Luhn por azar) y conserva operación, etiquetas y servicios', () => {
    const t = trace([span('01', 'POST /v1/*path', 'p1', 'ff', { ...server, startTime: 4_111_111_111_111_111 })]);
    expect(JSON.stringify(t)).toContain('4111111111111111');
    const content = contentTextOf(t);
    expect(content).not.toContain('4111111111111111');
    expect(content).not.toContain('ttttttttttttttttttttttttttttttt');
    expect(content).toContain('POST /v1/*path');
    expect(content).toContain('pay-edge');
    expect(content).toContain('/x');
  });

  it('INVÁLIDO: un PAN puesto en una etiqueta SÍ queda en el contenido (el filtro no esconde datos del cliente)', () => {
    const t = trace([span('01', 'GET', 'p1', undefined, { tags: [{ key: 'url.query', type: 'string', value: 'card=4111111111111111' }] })]);
    expect(contentTextOf(t)).toContain('4111111111111111');
  });
});
