import { comparePair, DECLARED_NOT_APPLICABLE, groupByBinding, PARITY_PAIRS, parityExitCode, REAL_CONNECTORS, renderParity, type JestJson } from './parity.ts';

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

// ───────────────────────── P1.H5.M4 (ola 4): NO APLICA declarado, todo/skipped idénticos, failed siempre DIFERENCIA ─────────────────────────

const EXPIRED = 'límite: un cobro que nadie paga sigue `pending` hasta su vencimiento y recién entonces se informa `expired`';
const EXPIRED_NA = `${EXPIRED} — NO APLICA: un banco remoto usa su propia hora, o cobra al instante (no hay cobro que venza); el vencimiento se prueba en test/mockbank.spec.ts (caso 08)`;
const MEDIO = 'inválido: un medio que el conector no declara se rechaza';
const MEDIO_NA = `${MEDIO} — NO APLICA: el conector declara varios medios`;
const verdictOf = (all: JestJson, index = 0) => comparePair(groupByBinding(all), PARITY_PAIRS[index]!);

describe('paridad mock/real — NO APLICA declarado (nivel CORRECTO)', () => {
  it('el caso «expired» con sufijo NO APLICA solo sobre HTTP se empareja con el de en proceso (sufijo ignorado) y, por estar DECLARADO, es PARIDAD', () => {
    const all = json([t(IN_PROCESS, EXPIRED, 'passed'), t(OVER_HTTP, EXPIRED_NA, 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.onlyInProcess).toEqual([]);
    expect(v.onlyOverHttp).toEqual([]);
    expect(v.verdict).toBe('PARIDAD');
    expect(v.notApplicable).toHaveLength(1);
    expect(v.notApplicable[0]).toMatchObject({ side: 'overHttp' });
    expect(v.notApplicable[0]!.reference).toContain('mockbank.spec.ts caso 08');
    expect(v.tests).toBe(2);
  });

  it('un NO APLICA en AMBOS lados, declarado como «both», es PARIDAD y el informe lo imprime con su referencia', () => {
    const all = json([t(IN_PROCESS, MEDIO_NA, 'todo'), t(OVER_HTTP, MEDIO_NA, 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('PARIDAD');
    expect(v.notApplicable.map((n) => n.side)).toEqual(['both']);
    const text = renderParity([v]);
    expect(text).toContain('NO APLICA declarado (ambos lados)');
    expect(text).toContain('1 NO APLICA declarados');
  });

  it('cada NO APLICA que declara la lista tiene un motivo y una referencia (no hay declaraciones vacías)', () => {
    expect(DECLARED_NOT_APPLICABLE.length).toBeGreaterThanOrEqual(11);
    for (const d of DECLARED_NOT_APPLICABLE) {
      expect(d.test.length).toBeGreaterThan(5);
      expect(d.reasonContains.length).toBeGreaterThan(5);
      expect(d.reference).toMatch(/\.ts|docs\//);
      expect(PARITY_PAIRS.map((p) => p.name)).toContain(d.pair);
    }
  });

  it('todo/skipped SIN sufijo, idénticos en ambos lados, no rompen la paridad y se IMPRIMEN con su cuenta', () => {
    const all = json([t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed'), t(IN_PROCESS, 'pendiente de P4', 'todo'), t(OVER_HTTP, 'pendiente de P4', 'todo'), t(IN_PROCESS, 'saltada', 'pending'), t(OVER_HTTP, 'saltada', 'pending')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('PARIDAD');
    expect(v.skippedOrTodo).toEqual({ todo: 1, skipped: 1 });
    expect(renderParity([v])).toContain('todo/skipped idénticos en ambos lados: 1 todo · 1 skipped');
  });
});

describe('paridad mock/real — NO APLICA (nivel LÍMITE)', () => {
  it('un NO APLICA declarado solo para HTTP, si aparece también en proceso, es DIFERENCIA (la declaración no cubre ese lado)', () => {
    const all = json([t(IN_PROCESS, EXPIRED_NA, 'todo'), t(OVER_HTTP, EXPIRED_NA, 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.undeclared.map((u) => u.side)).toEqual(['inProcess']); // el lado HTTP sí está declarado; el de en proceso no
  });

  it('un NO APLICA cuyo motivo cambió (ya no coincide con la declaración) es DIFERENCIA aunque el título sea el declarado', () => {
    const all = json([t(IN_PROCESS, EXPIRED, 'passed'), t(OVER_HTTP, `${EXPIRED} — NO APLICA: porque sí`, 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.undeclared[0]).toMatchObject({ side: 'overHttp', reason: 'porque sí' });
  });

  it('todo/skipped sin sufijo en UN solo lado es DIFERENCIA (estado distinto)', () => {
    const all = json([t(IN_PROCESS, 'x', 'passed'), t(OVER_HTTP, 'x', 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.differentStatus).toEqual([{ test: 'suite › x', inProcess: 'passed', overHttp: 'todo' }]);
  });

  it('un NO APLICA declarado en un lado con el otro lado FALLANDO es DIFERENCIA, y el failed se informa', () => {
    const all = json([t(IN_PROCESS, EXPIRED, 'failed'), t(OVER_HTTP, EXPIRED_NA, 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.failed).toEqual([{ test: `suite › ${EXPIRED}`, side: 'inProcess' }]);
  });

  it('el mismo NO APLICA declarado de un par NO sirve en el otro par (la declaración es por par)', () => {
    const all = json([t(BT_IN, MEDIO_NA, 'todo'), t(BT_HTTP, MEDIO_NA, 'todo'), t(BT_IN, 'b', 'passed'), t(BT_HTTP, 'b', 'passed')]);
    const v = verdictOf(all, 1);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.undeclared).toHaveLength(2);
  });
});

describe('paridad mock/real — failed y estados (nivel INVÁLIDO)', () => {
  it('un failed en AMBOS lados es DIFERENCIA (dos rojos iguales no son paridad)', () => {
    const v = verdictOf(json([t(IN_PROCESS, 'a', 'failed'), t(OVER_HTTP, 'a', 'failed'), t(IN_PROCESS, 'b', 'passed'), t(OVER_HTTP, 'b', 'passed')]));
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.failed.map((f) => f.side)).toEqual(['inProcess', 'overHttp']);
    expect(renderParity([v])).toContain('FALLA (en proceso): suite › a');
  });

  it('un failed solo en proceso es DIFERENCIA y exit 1 aunque el resto sea paridad', () => {
    const all = json([t(IN_PROCESS, 'a', 'failed'), t(OVER_HTTP, 'a', 'passed'), t(BT_IN, 'b', 'passed'), t(BT_HTTP, 'b', 'passed')]);
    const verdicts = PARITY_PAIRS.map((pair) => comparePair(groupByBinding(all), pair));
    expect(verdicts.map((v) => v.verdict)).toEqual(['DIFERENCIA', 'PARIDAD']);
    expect(parityExitCode(verdicts)).toBe(1);
  });

  it('un NO APLICA no declarado (prueba nueva que la suite marca como NO APLICA) es DIFERENCIA y se imprime como tal', () => {
    const all = json([t(IN_PROCESS, 'nueva — NO APLICA: porque sí', 'todo'), t(OVER_HTTP, 'nueva — NO APLICA: porque sí', 'todo'), t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'passed')]);
    const v = verdictOf(all);
    expect(v.verdict).toBe('DIFERENCIA');
    expect(renderParity([v])).toContain('NO APLICA SIN DECLARAR');
  });

  it('un enlace con solo NO APLICA/todo y ninguna prueba verde no es paridad', () => {
    const v = verdictOf(json([t(IN_PROCESS, MEDIO_NA, 'todo'), t(OVER_HTTP, MEDIO_NA, 'todo')]));
    expect(v.verdict).toBe('DIFERENCIA');
    expect(v.passedInProcess).toBe(0);
  });

  it('un lado `skipped` y el otro `passed`, sin sufijo declarado, es DIFERENCIA y el exit no baja a 0', () => {
    const v = verdictOf(json([t(IN_PROCESS, 'a', 'passed'), t(OVER_HTTP, 'a', 'skipped' as never), t(IN_PROCESS, 'b', 'passed'), t(OVER_HTTP, 'b', 'passed')]));
    expect(parityExitCode([v])).toBe(1);
  });
});
