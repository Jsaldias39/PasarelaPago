/**
 * Paridad mock/real de los conectores (P1.H5.M4, D-26). La suite de contrato de P4 (`services/pay-connectors/test/contract/`) es UNA sola, parametrizada por
 * enlace (`binding`): el mismo conjunto de pruebas corre contra el banco simulado EN PROCESO y contra el `pay-mockbank` REAL por HTTP. Acá se leen los
 * resultados de jest (`--json`) y se comprueba que cada par de enlaces tenga las MISMAS pruebas con el MISMO resultado. Los conectores del Banco Mercantil no
 * existen (el banco no entregó documentación): se informan BLOQUEADOS con su motivo, nunca como verdes.
 */
export interface JestAssertion {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped' | 'disabled';
}
export interface JestJson {
  readonly testResults: readonly { readonly assertionResults: readonly JestAssertion[] }[];
}

/** Pares (referencia en proceso, enlace contra pay-mockbank) por prefijo del título del `describe` de la suite. */
export const PARITY_PAIRS: readonly { readonly name: string; readonly inProcess: string; readonly overHttp: string }[] = [
  { name: 'conector mock', inProcess: 'mock — banco en proceso', overHttp: 'mock — pay-mockbank por HTTP' },
  { name: 'conector bank_transfer', inProcess: 'bank_transfer — extracto en proceso', overHttp: 'bank_transfer — cuenta `transfers` de pay-mockbank' },
];

/** Los conectores reales: sin adaptador (Q-01, Q-11). El motivo sale de la propia suite (`BLOCKED_REASON`) y se repite acá para el informe. */
export const REAL_CONNECTORS: readonly { readonly code: string; readonly reason: string }[] = [
  { code: 'mercantil_qr', reason: 'BLOQUEADO — el Banco Mercantil Santa Cruz no entregó documentación de API ni ambiente de pruebas (docs/spikes/banco-mercantil.md, Q-01, Q-11); no hay adaptador real que probar' },
  { code: 'mercantil_card', reason: 'BLOQUEADO — ídem (docs/spikes/banco-mercantil.md, Q-01, Q-11); la tarjeta además exige el vault real y el alcance PCI (docs/cumplimiento/pci-alcance.md)' },
];

export interface BindingResult {
  readonly title: string;
  readonly byTest: ReadonlyMap<string, string>;
}

/** Agrupa los resultados por el título del `describe` de primer nivel (el enlace). */
export function groupByBinding(json: JestJson): BindingResult[] {
  const groups = new Map<string, Map<string, string>>();
  for (const file of json.testResults) {
    for (const t of file.assertionResults) {
      const binding = t.ancestorTitles[0];
      if (binding === undefined) continue;
      const rest = [...t.ancestorTitles.slice(1), t.title].join(' › ');
      if (!groups.has(binding)) groups.set(binding, new Map());
      groups.get(binding)!.set(rest, t.status);
    }
  }
  return [...groups].map(([title, byTest]) => ({ title, byTest }));
}

export interface PairVerdict {
  readonly name: string;
  readonly verdict: 'PARIDAD' | 'DIFERENCIA' | 'SIN_DATOS';
  readonly tests: number;
  readonly passedInProcess: number;
  readonly passedOverHttp: number;
  readonly onlyInProcess: string[];
  readonly onlyOverHttp: string[];
  readonly differentStatus: { test: string; inProcess: string; overHttp: string }[];
}

export function comparePair(bindings: readonly BindingResult[], pair: (typeof PARITY_PAIRS)[number]): PairVerdict {
  const find = (prefix: string) => bindings.find((b) => b.title.startsWith(prefix));
  const a = find(pair.inProcess);
  const b = find(pair.overHttp);
  const empty = { name: pair.name, tests: 0, passedInProcess: 0, passedOverHttp: 0, onlyInProcess: [], onlyOverHttp: [], differentStatus: [] };
  if (!a || !b || a.byTest.size === 0 || b.byTest.size === 0) return { ...empty, verdict: 'SIN_DATOS' };
  const onlyInProcess = [...a.byTest.keys()].filter((k) => !b.byTest.has(k));
  const onlyOverHttp = [...b.byTest.keys()].filter((k) => !a.byTest.has(k));
  const differentStatus = [...a.byTest].filter(([k, v]) => b.byTest.has(k) && b.byTest.get(k) !== v).map(([k, v]) => ({ test: k, inProcess: v, overHttp: b.byTest.get(k)! }));
  const count = (r: BindingResult) => [...r.byTest.values()].filter((s) => s === 'passed').length;
  const ok = onlyInProcess.length === 0 && onlyOverHttp.length === 0 && differentStatus.length === 0 && count(a) === a.byTest.size && count(b) === b.byTest.size;
  return { name: pair.name, verdict: ok ? 'PARIDAD' : 'DIFERENCIA', tests: a.byTest.size, passedInProcess: count(a), passedOverHttp: count(b), onlyInProcess, onlyOverHttp, differentStatus };
}

export function renderParity(verdicts: readonly PairVerdict[]): string {
  const lines = ['Paridad mock/real de conectores (suite de contrato de P4)'];
  for (const v of verdicts) {
    lines.push(`  ${v.verdict.padEnd(10)} ${v.name}: ${v.tests} pruebas · en proceso ${v.passedInProcess} verdes · contra pay-mockbank ${v.passedOverHttp} verdes`);
    for (const t of v.onlyInProcess) lines.push(`      solo en proceso: ${t}`);
    for (const t of v.onlyOverHttp) lines.push(`      solo contra pay-mockbank: ${t}`);
    for (const d of v.differentStatus) lines.push(`      distinto: ${d.test} (en proceso: ${d.inProcess} · pay-mockbank: ${d.overHttp})`);
  }
  for (const r of REAL_CONNECTORS) lines.push(`  BLOQUEADO  ${r.code}: ${r.reason}`);
  return lines.join('\n');
}

/** Exit 0 solo si TODOS los pares tienen paridad. Los reales bloqueados no suman ni restan: se informan. */
export const parityExitCode = (verdicts: readonly PairVerdict[]): number => (verdicts.length > 0 && verdicts.every((v) => v.verdict === 'PARIDAD') ? 0 : 1);
