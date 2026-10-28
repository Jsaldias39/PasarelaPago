import { comparePair, groupByBinding, PARITY_PAIRS, parityExitCode, REAL_CONNECTORS, renderParity, type JestJson } from './parity.ts';

const t = (binding: string, title: string, status: string, group = 'suite') => ({ ancestorTitles: [binding, group], title, status }) as never;
const json = (assertions: unknown[]): JestJson => ({ testResults: [{ assertionResults: assertions as never }] });
const IN_PROCESS = 'mock — banco en proceso (SimulatedBank)';
const OVER_HTTP = 'mock — pay-mockbank por HTTP (proceso real)';
const BT_IN = 'bank_transfer — extracto en proceso (SimulatedBank)';
const BT_HTTP = 'bank_transfer — cuenta `transfers` de pay-mockbank (proceso real)';

describe('paridad mock/real — nivel CORRECTO', () => {
  it('mismas pruebas y mismo resultado en los dos enlaces ⇒ PARIDAD, exit 0 con ambos pares', () => {
    const all = json([
      t(IN_PROCESS, 'crea un cobro', 'passed'), t(OVER_HTTP, 'crea un cobro', 'passed'),
      t(IN_PROCESS, 'repite el callback', 'passed'), t(OVER_HTTP, 'repite el callback', 'passed'),
      t(BT_IN, 'concilia', 'passed'), t(BT_HTTP, 'concilia', 'passed'),
    ]);
    const verdicts = PARITY_PAIRS.map((pair) => comparePair(groupByBinding(all), pair));
    expect(verdicts.map((v) => [v.name, v.verdict, v.tests])).toEqual([['conector mock', 'PARIDAD', 2], ['conector bank_transfer', 'PARIDAD', 1]]);
    expect(parityExitCode(verdicts)).toBe(0);
  });

  it('el informe nombra los conectores reales como BLOQUEADOS con su motivo', () => {
    const text = renderParity([]);
    for (const r of REAL_CONNECTORS) expect(text).toContain(`BLOQUEADO  ${r.code}`);
    expect(text).toContain('docs/spikes/banco-mercantil.md');
    expect(text).not.toMatch(/PARIDAD.*mercantil/);
  });
});

describe('paridad mock/real — nivel LÍMITE: el instrumento detecta diferencias', () => {
  it('una prueba que falla solo contra pay-mockbank ⇒ DIFERENCIA y exit 1', () => {
    const all = json([t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'failed'), t(BT_IN, 'b', 'passed'), t(BT_HTTP, 'b', 'passed')]);
    const verdicts = PARITY_PAIRS.map((pair) => comparePair(groupByBinding(all), pair));
    expect(verdicts[0]!.verdict).toBe('DIFERENCIA');
    expect(verdicts[0]!.differentStatus).toEqual([{ test: 'suite › a', inProcess: 'passed', overHttp: 'failed' }]);
    expect(parityExitCode(verdicts)).toBe(1);
  });

  it('una prueba que existe en un enlace y no en el otro ⇒ DIFERENCIA (no se puede «ganar» paridad saltando una prueba)', () => {
    const all = json([t(IN_PROCESS, 'a', 'passed'), t(IN_PROCESS, 'solo-aqui', 'passed'), t(OVER_HTTP, 'a', 'passed'), t(BT_IN, 'b', 'passed'), t(BT_HTTP, 'b', 'passed')]);
    const v = comparePair(groupByBinding(all), PARITY_PAIRS[0]!);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.onlyInProcess).toEqual(['suite › solo-aqui']);
  });

  it('una prueba saltada o pendiente en AMBOS enlaces tampoco es paridad verde', () => {
    const all = json([t(IN_PROCESS, 'a', 'pending'), t(OVER_HTTP, 'a', 'pending')]);
    expect(comparePair(groupByBinding(all), PARITY_PAIRS[0]!).verdict).toBe('DIFERENCIA');
  });
});

describe('paridad mock/real — nivel INVÁLIDO', () => {
  it('sin resultados de un enlace ⇒ SIN_DATOS y exit 1 (jamás verde por falta de datos)', () => {
    const v = comparePair(groupByBinding(json([t(IN_PROCESS, 'a', 'passed')])), PARITY_PAIRS[0]!);
    expect(v.verdict).toBe('SIN_DATOS');
    expect(parityExitCode([v])).toBe(1);
    expect(parityExitCode([])).toBe(1);
  });

  it('un JSON vacío o con pruebas sin describe no revienta', () => {
    expect(groupByBinding({ testResults: [] })).toEqual([]);
    expect(groupByBinding(json([{ ancestorTitles: [], title: 'suelta', status: 'passed' }]))).toEqual([]);
  });
});
