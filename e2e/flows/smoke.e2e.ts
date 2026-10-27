import { renderSmoke, runSmoke, type SmokeReport } from '../lib/smoke.ts';
import { SERVICES, startStack, stopStack, type Stack } from '../stack.ts';

/** Humo del stack real: cada servicio arranca y está sano, y cada llamada interna declarada en los contratos pasa la identidad. */
describe('humo del stack real', () => {
  let stack: Stack;
  let report: SmokeReport;

  beforeAll(async () => {
    stack = await startStack();
    report = await runSmoke(stack);
    if (process.env.E2E_LOG) process.stdout.write(`${renderSmoke(report)}\n`);
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it.each(SERVICES.map((n) => [n]))('%s arranca y queda sano (readiness real)', (name) => {
    expect({ name, healthy: stack.services[name].healthy, error: stack.services[name].error }).toEqual({ name, healthy: true, error: undefined });
  });

  it('cada llamada interna de los contratos responde SIN 401/403 por identidad ni por X-Pay-Mode, y sin 5xx ni rutas ausentes', () => {
    const bad = report.cases.filter((c) => c.group === 'interna' && c.verdict !== 'OK');
    expect(bad).toEqual([]);
    expect(report.cases.filter((c) => c.group === 'interna').length).toBeGreaterThanOrEqual(40);
  });

  it('los controles negativos funcionan: un llamador fuera de la lista recibe 403 (la identidad se hace cumplir)', () => {
    const controls = report.cases.filter((c) => c.group === 'control');
    expect(controls.length).toBeGreaterThanOrEqual(7);
    expect(controls.filter((c) => c.verdict !== 'OK')).toEqual([]);
  });

  it('el borde reenvía las 20 operaciones públicas a sus dueños con una clave sk_test_ real', () => {
    const edge = report.cases.filter((c) => c.group === 'borde');
    expect(edge).toHaveLength(20);
    expect(edge.filter((c) => c.verdict !== 'OK')).toEqual([]);
  });

  it('nada quedó sin ejercitar', () => {
    expect(report.skipped).toEqual([]);
    expect(report.failures).toBe(0);
  });
});
