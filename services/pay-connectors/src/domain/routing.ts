import type { ConnectorCode, Method } from './connector';

/**
 * Motor de ruteo declarativo y versionado (patrón del *decision engine* de Hyperswitch, sin ML ni costos: reglas ordenadas).
 * La primera regla que coincide fija el orden de preferencia de conectores; los que no están registrados o están caídos se saltan.
 */
export interface RoutingRule {
  readonly id: string;
  readonly when: { readonly method?: Method; readonly amount_min_minor?: number; readonly amount_max_minor?: number };
  readonly route: readonly ConnectorCode[];
}

export interface RuleSet {
  readonly version: number;
  readonly rules: readonly RoutingRule[];
}

const CODES = new Set<string>(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']);
const METHODS = new Set<string>(['qr', 'card', 'bank_transfer']);

/** Valida un conjunto de reglas (por ejemplo, el que se lee de la base). Estricto: campo desconocido o regla mal formada ⇒ error. */
export function parseRuleSet(input: unknown): RuleSet {
  const fail = (m: string): never => {
    throw new Error(`Reglas de ruteo inválidas: ${m}`);
  };
  if (typeof input !== 'object' || input === null) return fail('no es un objeto');
  const { version, rules, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) fail(`campo desconocido ${Object.keys(rest)[0]}`);
  if (!Number.isInteger(version) || (version as number) < 1) fail('version');
  if (!Array.isArray(rules)) return fail('rules');
  const ids = new Set<string>();
  const parsed = (rules as unknown[]).map((raw, i): RoutingRule => {
    if (typeof raw !== 'object' || raw === null) return fail(`regla ${i}`);
    const { id, when, route, ...extra } = raw as Record<string, unknown>;
    if (Object.keys(extra).length > 0) fail(`regla ${i}: campo desconocido ${Object.keys(extra)[0]}`);
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) fail(`regla ${i}: id`);
    ids.add(id as string);
    if (typeof when !== 'object' || when === null) return fail(`regla ${id}: when`);
    const w = when as Record<string, unknown>;
    for (const key of Object.keys(w)) if (!['method', 'amount_min_minor', 'amount_max_minor'].includes(key)) fail(`regla ${id}: when.${key}`);
    if (w.method !== undefined && !METHODS.has(w.method as string)) fail(`regla ${id}: method`);
    for (const key of ['amount_min_minor', 'amount_max_minor'] as const) {
      if (w[key] !== undefined && (!Number.isSafeInteger(w[key]) || (w[key] as number) < 0)) fail(`regla ${id}: ${key}`);
    }
    if (!Array.isArray(route) || route.length === 0 || route.some((c) => !CODES.has(c as string))) fail(`regla ${id}: route`);
    return { id: id as string, when: w as RoutingRule['when'], route: route as ConnectorCode[] };
  });
  return { version: version as number, rules: parsed };
}

/** Reglas por defecto (versión 1). Los adaptadores `mercantil_*` aparecen primero: se usan en cuanto estén registrados. */
export const DEFAULT_RULE_SET: RuleSet = {
  version: 1,
  rules: [
    { id: 'qr', when: { method: 'qr' }, route: ['mercantil_qr', 'mock'] },
    { id: 'card', when: { method: 'card' }, route: ['mercantil_card', 'mock'] },
    { id: 'bank_transfer', when: { method: 'bank_transfer' }, route: ['bank_transfer'] },
  ],
};

export interface Availability {
  readonly registered: boolean;
  readonly down: boolean;
  readonly methods: readonly Method[];
}

export interface RoutingChoice {
  readonly version: number;
  readonly ruleId: string | null;
  /** Orden en que se intenta. Vacío ⇒ ningún conector sirve (502 `connector_unavailable`). */
  readonly candidates: readonly ConnectorCode[];
}

export function selectCandidates(
  ruleSet: RuleSet,
  request: { method: Method; amountMinor: bigint; preferred?: ConnectorCode },
  availability: (code: ConnectorCode) => Availability,
): RoutingChoice {
  const rule = ruleSet.rules.find((r) => {
    if (r.when.method !== undefined && r.when.method !== request.method) return false;
    if (r.when.amount_min_minor !== undefined && request.amountMinor < BigInt(r.when.amount_min_minor)) return false;
    if (r.when.amount_max_minor !== undefined && request.amountMinor > BigInt(r.when.amount_max_minor)) return false;
    return true;
  });
  if (!rule) return { version: ruleSet.version, ruleId: null, candidates: [] };
  const usable = rule.route.filter((code) => {
    const a = availability(code);
    return a.registered && !a.down && a.methods.includes(request.method);
  });
  // `preferred_connector` solo reordena dentro de lo que la regla permite; nunca habilita un conector que la regla no lista.
  const ordered = request.preferred && usable.includes(request.preferred) ? [request.preferred, ...usable.filter((c) => c !== request.preferred)] : usable;
  return { version: ruleSet.version, ruleId: rule.id, candidates: ordered };
}
