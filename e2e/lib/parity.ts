/**
 * Paridad mock/real de los conectores (P1.H5.M4, D-26). La suite de contrato de P4 (`services/pay-connectors/test/contract/`) es UNA sola, parametrizada por
 * enlace (`binding`): el mismo conjunto de pruebas corre contra el banco simulado EN PROCESO y contra el `pay-mockbank` REAL por HTTP. Acá se leen los
 * resultados de jest (`--json`) y se comprueba que cada par de enlaces tenga las MISMAS pruebas con el MISMO resultado. Los conectores del Banco Mercantil no
 * existen (el banco no entregó documentación): se informan BLOQUEADOS con su motivo, nunca como verdes.
 *
 * Qué es PARIDAD (P1.H5.M4, ola 4): el MISMO conjunto de pruebas y el MISMO estado en los dos enlaces. Un `failed` en cualquier lado es DIFERENCIA siempre.
 * Una prueba que no aplica a un enlace la declara la propia suite como `todo` con el sufijo « — NO APLICA: <motivo>»; ese sufijo se IGNORA al emparejar títulos,
 * pero la inaplicabilidad solo cuenta si está DECLARADA acá (`DECLARED_NOT_APPLICABLE`, con motivo y referencia): un NO APLICA no declarado es DIFERENCIA.
 * Un `todo`/`skipped` sin sufijo solo es aceptable si es idéntico en ambos lados, y se imprime con su cuenta. Sin ninguna prueba verde en un lado no hay paridad.
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

/**
 * Inaplicabilidades DECLARADAS. Cada una nombra el par, el lado (`inProcess`, `overHttp` o `both`), un fragmento ÚNICO del título de la prueba (sin el sufijo NO APLICA), un fragmento
 * del motivo que la suite da (si la suite cambia el motivo, deja de coincidir y es DIFERENCIA) y dónde se justifica. Agregar una acá es una decisión revisable, no un parche del informe.
 */
export interface DeclaredNotApplicable {
  readonly pair: string;
  readonly side: 'inProcess' | 'overHttp' | 'both';
  readonly test: string;
  readonly reasonContains: string;
  readonly reference: string;
}

const CAPS = 'services/pay-connectors/test/contract/contract.spec.ts (capacidades del enlace) y connector-contract.ts `only(...)`';
export const DECLARED_NOT_APPLICABLE: readonly DeclaredNotApplicable[] = [
  // conector mock
  { pair: 'conector mock', side: 'overHttp', test: 'un cobro que nadie paga sigue `pending` hasta su vencimiento', reasonContains: 'el vencimiento se prueba en test/mockbank.spec.ts (caso 08)', reference: 'services/pay-connectors/test/mockbank.spec.ts caso 08 (escenario …08: pasa a `expired` al llegar `expires_at`); el reloj del banco remoto no es el de la prueba' },
  { pair: 'conector mock', side: 'both', test: 'un medio que el conector no declara se rechaza', reasonContains: 'el conector declara varios medios', reference: CAPS },
  { pair: 'conector mock', side: 'both', test: 'el depósito del pagador con la referencia de las instrucciones aparece en el extracto', reasonContains: 'cobra por callback/consulta, no por depósitos', reference: CAPS },
  // conector bank_transfer (los mismos 8 en los dos enlaces)
  ...[
    ['timeout ambiguo: ConnectorTimeoutError', 'no tiene escenario de timeout ambiguo'],
    ['rechazo síncrono: el importe «rechazado»', 'no tiene escenario de rechazo síncrono'],
    ['reembolso parcial de un cobro cobrado', 'orden de pago saliente (no modelada)'],
    ['getRefund de una referencia que el banco no tiene', 'este conector no reembolsa'],
    ['un callback bien firmado se interpreta en un evento', 'no avisa por callback'],
    ['un cobro cobrado aparece como crédito con NUESTRA referencia', 'son depósitos del pagador, no cobros'],
    ['la orden se paga, es idempotente por referencia', 'no paga transferencias salientes'],
    ['Bs …01 la rechaza (`rejected_by_bank`)', 'no paga transferencias salientes'],
  ].map(([test, reasonContains]): DeclaredNotApplicable => ({ pair: 'conector bank_transfer', side: 'both', test: test!, reasonContains: reasonContains!, reference: `${CAPS}: bank_transfer cobra por depósito del pagador conciliado por extracto` })),
];

export type TestState = 'passed' | 'failed' | 'not_applicable' | 'todo' | 'skipped';

export interface TestEntry {
  readonly state: TestState;
  /** Motivo dado por la suite en el sufijo « — NO APLICA: …» (solo con `not_applicable`). */
  readonly reason?: string;
}

export interface BindingResult {
  readonly title: string;
  readonly byTest: ReadonlyMap<string, TestEntry>;
}

const NOT_APPLICABLE_SUFFIX = /\s+—\s+NO APLICA:\s+([\s\S]*)$/;

/** Estado normalizado de una aserción de jest y su título SIN el sufijo NO APLICA. */
function normalize(title: string, status: JestAssertion['status']): { title: string; entry: TestEntry } {
  const suffix = NOT_APPLICABLE_SUFFIX.exec(title);
  if (status === 'passed') return { title, entry: { state: 'passed' } };
  if (status === 'failed') return { title, entry: { state: 'failed' } };
  if (suffix && status === 'todo') return { title: title.slice(0, suffix.index), entry: { state: 'not_applicable', reason: suffix[1]! } };
  return { title, entry: { state: status === 'todo' ? 'todo' : 'skipped' } };
}

/** Agrupa los resultados por el título del `describe` de primer nivel (el enlace). */
export function groupByBinding(json: JestJson): BindingResult[] {
  const groups = new Map<string, Map<string, TestEntry>>();
  for (const file of json.testResults) {
    for (const t of file.assertionResults) {
      const binding = t.ancestorTitles[0];
      if (binding === undefined) continue;
      const normalized = normalize(t.title, t.status);
      const rest = [...t.ancestorTitles.slice(1), normalized.title].join(' › ');
      if (!groups.has(binding)) groups.set(binding, new Map());
      groups.get(binding)!.set(rest, normalized.entry);
    }
  }
  return [...groups].map(([title, byTest]) => ({ title, byTest }));
}

export interface PairVerdict {
  readonly name: string;
  readonly verdict: 'PARIDAD' | 'DIFERENCIA' | 'SIN_DATOS';
  /** Pruebas distintas (unión de los dos enlaces, con el sufijo NO APLICA ignorado). */
  readonly tests: number;
  readonly passedInProcess: number;
  readonly passedOverHttp: number;
  readonly onlyInProcess: string[];
  readonly onlyOverHttp: string[];
  readonly differentStatus: { test: string; inProcess: string; overHttp: string }[];
  /** `failed` en cualquier lado. */
  readonly failed: { test: string; side: 'inProcess' | 'overHttp' }[];
  /** NO APLICA declarados y comprobados (con su referencia). */
  readonly notApplicable: { test: string; side: 'inProcess' | 'overHttp' | 'both'; reference: string }[];
  /** NO APLICA que la suite emite y nadie declaró (o cuyo motivo ya no coincide). */
  readonly undeclared: { test: string; side: 'inProcess' | 'overHttp'; reason: string }[];
  /** `todo`/`skipped` sin sufijo, idénticos en ambos lados: se imprimen con su cuenta. */
  readonly skippedOrTodo: { todo: number; skipped: number };
}

export function comparePair(bindings: readonly BindingResult[], pair: (typeof PARITY_PAIRS)[number], declared: readonly DeclaredNotApplicable[] = DECLARED_NOT_APPLICABLE): PairVerdict {
  const find = (prefix: string) => bindings.find((b) => b.title.startsWith(prefix));
  const a = find(pair.inProcess);
  const b = find(pair.overHttp);
  const empty = { name: pair.name, tests: 0, passedInProcess: 0, passedOverHttp: 0, onlyInProcess: [], onlyOverHttp: [], differentStatus: [], failed: [], notApplicable: [], undeclared: [], skippedOrTodo: { todo: 0, skipped: 0 } };
  if (!a || !b || a.byTest.size === 0 || b.byTest.size === 0) return { ...empty, verdict: 'SIN_DATOS' };

  const mine = declared.filter((d) => d.pair === pair.name);
  const matches = (key: string, d: DeclaredNotApplicable) => key.includes(d.test);
  const onlyInProcess = [...a.byTest.keys()].filter((k) => !b.byTest.has(k));
  const onlyOverHttp = [...b.byTest.keys()].filter((k) => !a.byTest.has(k));
  const differentStatus: PairVerdict['differentStatus'] = [];
  const failed: PairVerdict['failed'] = [];
  const notApplicable: PairVerdict['notApplicable'] = [];
  const undeclared: PairVerdict['undeclared'] = [];
  const skippedOrTodo = { todo: 0, skipped: 0 };

  for (const key of [...a.byTest.keys()].filter((k) => b.byTest.has(k))) {
    const x = a.byTest.get(key)!;
    const y = b.byTest.get(key)!;
    if (x.state === 'failed') failed.push({ test: key, side: 'inProcess' });
    if (y.state === 'failed') failed.push({ test: key, side: 'overHttp' });
    if (x.state === 'failed' || y.state === 'failed') {
      if (x.state !== y.state) differentStatus.push({ test: key, inProcess: x.state, overHttp: y.state });
      continue;
    }
    // NO APLICA: cada lado que lo emite debe estar declarado (par + lado + prueba + motivo), y el otro lado debe pasar o declararse igual.
    const sidesNa = (['inProcess', 'overHttp'] as const).filter((side) => (side === 'inProcess' ? x : y).state === 'not_applicable');
    if (sidesNa.length > 0) {
      const covers = (side: 'inProcess' | 'overHttp') => {
        const entry = side === 'inProcess' ? x : y;
        return mine.find((d) => matches(key, d) && (d.side === side || (d.side === 'both' && sidesNa.length === 2)) && entry.reason!.includes(d.reasonContains));
      };
      let ok = true;
      for (const side of sidesNa) {
        if (!covers(side)) {
          undeclared.push({ test: key, side, reason: (side === 'inProcess' ? x : y).reason! });
          ok = false;
        }
      }
      const other = sidesNa.length === 1 ? (sidesNa[0] === 'inProcess' ? y : x) : undefined;
      if (other && other.state !== 'passed') {
        differentStatus.push({ test: key, inProcess: x.state, overHttp: y.state });
        ok = false;
      }
      if (ok) {
        const used = mine.find((d) => matches(key, d) && covers(sidesNa[0]!))!;
        notApplicable.push({ test: key, side: sidesNa.length === 2 ? 'both' : sidesNa[0]!, reference: used.reference });
      }
      continue;
    }
    if (x.state !== y.state) {
      differentStatus.push({ test: key, inProcess: x.state, overHttp: y.state });
      continue;
    }
    if (x.state === 'todo') skippedOrTodo.todo += 1;
    if (x.state === 'skipped') skippedOrTodo.skipped += 1;
  }
  const count = (r: BindingResult) => [...r.byTest.values()].filter((e) => e.state === 'passed').length;
  const passedInProcess = count(a);
  const passedOverHttp = count(b);
  const ok = onlyInProcess.length === 0 && onlyOverHttp.length === 0 && differentStatus.length === 0 && failed.length === 0 && undeclared.length === 0 && passedInProcess > 0 && passedOverHttp > 0;
  return { name: pair.name, verdict: ok ? 'PARIDAD' : 'DIFERENCIA', tests: new Set([...a.byTest.keys(), ...b.byTest.keys()]).size, passedInProcess, passedOverHttp, onlyInProcess, onlyOverHttp, differentStatus, failed, notApplicable, undeclared, skippedOrTodo };
}

export function renderParity(verdicts: readonly PairVerdict[]): string {
  const lines = ['Paridad mock/real de conectores (suite de contrato de P4)'];
  for (const v of verdicts) {
    lines.push(`  ${v.verdict.padEnd(10)} ${v.name}: ${v.tests} pruebas · en proceso ${v.passedInProcess} verdes · contra pay-mockbank ${v.passedOverHttp} verdes · ${v.notApplicable.length} NO APLICA declarados`);
    for (const f of v.failed) lines.push(`      FALLA (${f.side === 'inProcess' ? 'en proceso' : 'pay-mockbank'}): ${f.test}`);
    for (const t of v.onlyInProcess) lines.push(`      solo en proceso: ${t}`);
    for (const t of v.onlyOverHttp) lines.push(`      solo contra pay-mockbank: ${t}`);
    for (const d of v.differentStatus) lines.push(`      distinto: ${d.test} (en proceso: ${d.inProcess} · pay-mockbank: ${d.overHttp})`);
    for (const u of v.undeclared) lines.push(`      NO APLICA SIN DECLARAR (${u.side === 'inProcess' ? 'en proceso' : 'pay-mockbank'}): ${u.test} — ${u.reason}`);
    for (const n of v.notApplicable) lines.push(`      NO APLICA declarado (${n.side === 'both' ? 'ambos lados' : n.side === 'inProcess' ? 'solo en proceso' : 'solo pay-mockbank'}): ${n.test}\n          → ${n.reference}`);
    if (v.skippedOrTodo.todo + v.skippedOrTodo.skipped > 0) lines.push(`      todo/skipped idénticos en ambos lados: ${v.skippedOrTodo.todo} todo · ${v.skippedOrTodo.skipped} skipped`);
  }
  for (const r of REAL_CONNECTORS) lines.push(`  BLOQUEADO  ${r.code}: ${r.reason}`);
  return lines.join('\n');
}

/** Exit 0 solo si TODOS los pares tienen paridad. Los reales bloqueados no suman ni restan: se informan. */
export const parityExitCode = (verdicts: readonly PairVerdict[]): number => (verdicts.length > 0 && verdicts.every((v) => v.verdict === 'PARIDAD') ? 0 : 1);
