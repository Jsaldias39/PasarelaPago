import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadContract } from '@pay/testing';
import { SERVICES, type ServiceName, type Stack } from '../stack.ts';
import { ROOT } from './infra.ts';
import { seedMerchant, waitForEdgeToKnow } from './seed.ts';

export type Verdict = 'OK' | 'FALLA_IDENTIDAD' | 'FALLA_5XX' | 'RUTA_AUSENTE' | 'INALCANZABLE' | 'CONTROL_NEGATIVO_ROTO' | 'CONTRATO_ROTO';

export interface SmokeCase {
  readonly group: 'salud' | 'interna' | 'borde' | 'control';
  readonly from: string;
  readonly to: ServiceName;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly verdict: Verdict;
  readonly note?: string;
}

export interface SmokeReport {
  readonly runId: string;
  readonly cases: SmokeCase[];
  readonly failures: number;
  readonly skipped: string[];
}

interface Operation {
  method: string;
  path: string;
  hasPathParams: boolean;
  params: { name: string; pattern?: string }[];
}

export function loadOperations(file: string): Operation[] {
  type Param = { name?: string; in?: string; schema?: { pattern?: string } };
  type PathItem = { parameters?: Param[] } & Record<string, { parameters?: Param[] } | Param[] | undefined>;
  const doc = parse(readFileSync(join(ROOT, 'contracts/openapi', file), 'utf8')) as { paths: Record<string, PathItem> };
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method] as { parameters?: Param[] } | undefined;
      if (!op) continue;
      // Los parámetros de ruta salen de la PLANTILLA (los de `$ref` no traen nombre en línea); el patrón, si es inline, mejora el valor.
      const inline = [...(item.parameters ?? []), ...(op.parameters ?? [])].filter((p) => p.in === 'path' && p.name);
      const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => {
        const pattern = inline.find((p) => p.name === m[1])?.schema?.pattern;
        return { name: m[1], ...(pattern ? { pattern } : {}) };
      });
      out.push({ method: method.toUpperCase(), path, hasPathParams: params.length > 0, params });
    }
  }
  return out;
}

/** Un valor que cumple el patrón sencillo `^pre_[a-z0-9]{n,m}$` del contrato; si no hay patrón, uno neutro. */
function sampleValue(param: { name: string; pattern?: string }): string {
  const m = param.pattern?.match(/^\^([a-z]+)_\[a-z0-9\]\{(\d+)(?:,\d+)?\}\$$/);
  if (m) return `${m[1]}_${'a'.repeat(Number(m[2]))}`;
  return 'abcdefghij12';
}

export const fill = (op: Operation) => op.params.reduce((path, p) => path.replace(`{${p.name}}`, sampleValue(p)), op.path);

/**
 * Quién llama a quién, tomado de los contratos internos («Consume», la matriz de `internal-ledger-v1` y de `internal-settlement-v1`).
 * `only` acota las operaciones cuando el contrato restringe al llamador.
 */
interface Edge {
  readonly from: ServiceName;
  readonly to: ServiceName;
  readonly contract: string;
  readonly only?: (op: Operation) => boolean;
}
const LEDGER_OPS = (op: Operation) => !(op.method === 'GET' && op.path === '/balance');
export const CALL_PLAN: readonly Edge[] = [
  { from: 'pay-payments', to: 'pay-ledger', contract: 'internal-ledger-v1.yaml', only: LEDGER_OPS },
  { from: 'pay-settlement', to: 'pay-ledger', contract: 'internal-ledger-v1.yaml', only: LEDGER_OPS },
  { from: 'pay-schedules', to: 'pay-ledger', contract: 'internal-ledger-v1.yaml', only: LEDGER_OPS },
  { from: 'pay-payments', to: 'pay-connectors', contract: 'internal-connectors-v1.yaml', only: (op) => op.path.startsWith('/charges') || op.path.startsWith('/refunds') },
  { from: 'pay-settlement', to: 'pay-connectors', contract: 'internal-connectors-v1.yaml', only: (op) => op.path.startsWith('/transfers') || op.path === '/statements' },
  { from: 'pay-payments', to: 'pay-risk', contract: 'internal-risk-v1.yaml', only: (op) => op.path.startsWith('/assessments') },
  { from: 'pay-payments', to: 'pay-vault', contract: 'internal-vault-v1.yaml', only: (op) => !op.path.endsWith('/reveal') },
  { from: 'pay-connectors', to: 'pay-vault', contract: 'internal-vault-v1.yaml', only: (op) => op.path.endsWith('/reveal') },
  { from: 'pay-connectors', to: 'pay-qr', contract: 'internal-qr-v1.yaml', only: (op) => op.method !== 'GET' || !op.path.endsWith('/image') },
  { from: 'pay-schedules', to: 'pay-payments', contract: 'internal-payments-v1.yaml' },
  { from: 'pay-schedules', to: 'pay-settlement', contract: 'internal-settlement-v1.yaml', only: (op) => ['/payouts', '/payouts/{id}', '/charges'].includes(op.path) },
  { from: 'pay-payments', to: 'pay-settlement', contract: 'internal-settlement-v1.yaml', only: (op) => op.method === 'POST' && op.path === '/charges' },
];

/** Servicio que debería rechazar con 403 a un llamador que no figura en su lista (control negativo de la identidad). */
const STRANGER: Partial<Record<ServiceName, string>> = {
  'pay-ledger': 'pay-qr',
  'pay-connectors': 'pay-qr',
  'pay-risk': 'pay-qr',
  'pay-vault': 'pay-qr',
  'pay-qr': 'pay-risk',
  'pay-payments': 'pay-qr',
  'pay-settlement': 'pay-qr',
};

export function classify(status: number, op: Operation): { verdict: Verdict; note?: string } {
  if (status === 0) return { verdict: 'INALCANZABLE' };
  if (status === 401 || status === 403) return { verdict: 'FALLA_IDENTIDAD', note: status === 401 ? '401: el servicio no reconoce al llamador' : '403: identidad o X-Pay-Mode rechazados' };
  if (status >= 500) return { verdict: 'FALLA_5XX' };
  // Una operación sin parámetros de ruta que responde 404 no existe en el dueño: la ruta del contrato no está implementada o se llama distinto.
  if (status === 404 && !op.hasPathParams) return { verdict: 'RUTA_AUSENTE', note: 'el dueño no tiene esta ruta' };
  return { verdict: 'OK' };
}

const codeOf = (json: unknown): string | undefined => (typeof json === 'object' && json !== null && 'code' in json ? String((json as { code: unknown }).code) : undefined);

export async function runSmoke(stack: Stack): Promise<SmokeReport> {
  const cases: SmokeCase[] = [];
  const skipped: string[] = [];
  const up = (name: ServiceName) => stack.services[name].healthy;

  // 1. Salud: cada servicio vivo y listo.
  for (const name of SERVICES) {
    for (const path of ['/health/live', '/health/ready']) {
      const res = await stack.call(name, 'GET', path).catch(() => undefined);
      const status = res?.status ?? 0;
      cases.push({ group: 'salud', from: 'harness', to: name, method: 'GET', path, status, code: undefined, verdict: status === 200 ? 'OK' : status === 0 ? 'INALCANZABLE' : 'FALLA_5XX' });
    }
  }

  // 2. Llamadas internas declaradas en los contratos, con X-Service-Id y X-Pay-Mode del llamador.
  const merchantId = 'mc_aaaaaaaaaaaa';
  for (const edge of CALL_PLAN) {
    if (!up(edge.to)) {
      skipped.push(`${edge.from} → ${edge.to}: ${edge.to} no está sano`);
      continue;
    }
    for (const op of loadOperations(edge.contract).filter((o) => (edge.only ? edge.only(o) : true))) {
      const path = fill(op);
      const res = await stack.callAs(edge.from, edge.to, op.method, path, { merchantId, headers: { 'idempotency-key': `e2e-smoke-${Math.random().toString(36).slice(2, 12)}`, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, ...(['POST', 'PUT', 'PATCH'].includes(op.method) ? { json: {} } : {}) }).catch(() => undefined);
      const status = res?.status ?? 0;
      const { verdict, note } = classify(status, op);
      cases.push({ group: 'interna', from: edge.from, to: edge.to, method: op.method, path: op.path, status, code: codeOf(res?.json), verdict, ...(note ? { note } : {}) });
    }
  }

  // 3. Controles negativos: un llamador que NO figura en la lista debe recibir 403 (la identidad se hace cumplir de verdad).
  for (const [to, stranger] of Object.entries(STRANGER) as [ServiceName, string][]) {
    if (!up(to)) continue;
    const edge = CALL_PLAN.find((e) => e.to === to)!;
    const op = loadOperations(edge.contract).find((o) => (edge.only ? edge.only(o) : true))!;
    const res = await stack.callAs(stranger, to, op.method, fill(op), { merchantId, ...(['POST', 'PUT', 'PATCH'].includes(op.method) ? { json: {} } : {}) }).catch(() => undefined);
    const status = res?.status ?? 0;
    cases.push({ group: 'control', from: stranger, to, method: op.method, path: op.path, status, code: codeOf(res?.json), verdict: status === 403 ? 'OK' : 'CONTROL_NEGATIVO_ROTO', note: status === 403 ? 'rechazado como corresponde' : `esperaba 403 y recibió ${status}` });
  }

  // 4. Borde → dueños: la API pública con una clave sk_test_ real (creada por la semilla, publicada por el relé de pay-merchants).
  if (up('pay-edge') && up('pay-merchants')) {
    const merchant = await seedMerchant(stack);
    const known = await waitForEdgeToKnow(stack, merchant);
    if (!known.ok) {
      cases.push({ group: 'borde', from: 'cliente', to: 'pay-edge', method: 'GET', path: '/v1/merchants/me', status: 401, code: 'unauthorized', verdict: 'FALLA_IDENTIDAD', note: `el borde nunca reconoció la clave sembrada (${known.reason}): falla la cadena pay-merchants → NATS → réplica de pay-edge` });
    } else {
      const publicContract = await loadContract(join(ROOT, 'contracts/openapi/public-v1.yaml'));
      for (const op of loadOperations('public-v1.yaml')) {
        const path = fill(op);
        const res = await stack.call('pay-edge', op.method, `/v1${path}`, { headers: { authorization: `Bearer ${merchant.token}`, 'idempotency-key': `e2e-smoke-${Math.random().toString(36).slice(2, 12)}` }, ...(['POST', 'PUT', 'PATCH'].includes(op.method) ? { json: {} } : {}) }).catch(() => undefined);
        const status = res?.status ?? 0;
        let { verdict, note } = classify(status, op);
        // Test de consumidor GENERADO desde el OpenAPI público: cada operación del contrato se invoca contra el borde REAL y su respuesta (estado y cuerpo)
        // se valida contra lo que el contrato promete para esa operación. Un estado o una forma que el contrato no declara es un incumplimiento.
        if (verdict === 'OK' && res) {
          const errors = publicContract.validateResponse({ method: op.method, path, status, body: res.json ?? (res.text === '' ? undefined : res.text) });
          if (errors.length > 0) {
            verdict = 'CONTRATO_ROTO';
            note = errors.slice(0, 3).join('; ');
          }
        }
        cases.push({ group: 'borde', from: 'cliente(sk_test_)', to: 'pay-edge', method: op.method, path: op.path, status, code: codeOf(res?.json), verdict, ...(note ? { note } : {}) });
      }
    }
  } else {
    skipped.push('borde → dueños: pay-edge o pay-merchants no están sanos');
  }

  return { runId: stack.runId, cases, failures: cases.filter((c) => c.verdict !== 'OK').length + SERVICES.filter((n) => !up(n)).length, skipped };
}

export function renderSmoke(report: SmokeReport): string {
  const lines = report.cases.filter((c) => c.verdict !== 'OK').map((c) => `${c.verdict.padEnd(22)} ${c.from.padEnd(18)} → ${c.to.padEnd(15)} ${c.method.padEnd(6)} ${c.path.padEnd(40)} ${c.status}${c.code ? ` ${c.code}` : ''}${c.note ? `  (${c.note})` : ''}`);
  const byGroup = (g: string) => report.cases.filter((c) => c.group === g);
  const summary = (['salud', 'interna', 'control', 'borde'] as const).map((g) => `${g}: ${byGroup(g).filter((c) => c.verdict === 'OK').length}/${byGroup(g).length} OK`).join(' · ');
  return [`Humo e2e (${report.runId})`, summary, ...(report.skipped.length ? ['No ejercitado:', ...report.skipped.map((s) => `  - ${s}`)] : []), ...(lines.length ? ['Fallas:', ...lines] : ['Sin fallas.'])].join('\n');
}
