import { readFileSync } from 'node:fs';
import { type SettlementTestContext, createSettlementContext, key, merchantId, operatorToken, repoPath } from './helpers/app';

/**
 * Llamadas ENTRANTES documentadas por el contrato (`internal-settlement-v1.yaml`, «Quién llama a qué»): la tabla se lee del propio contrato,
 * no de una copia. Para cada par (servicio, operación) documentado se comprueba que LLEVA el modo (`X-Pay-Mode`), que sin él o con un valor
 * inválido recibe 403 igual que antes, y que un llamador NO documentado sigue recibiendo 403 aunque mande un modo válido (no se asumen
 * llamadores nuevos).
 */
let ctx: SettlementTestContext;
beforeAll(async () => {
  ctx = await createSettlementContext();
});
afterAll(async () => ctx.close());

interface Documented {
  readonly service: string;
  readonly operations: string[];
}

/** Lee la tabla `| X-Service-Id | Operaciones |` de la descripción del contrato. */
function documentedCallers(allOperations: string[]): Documented[] {
  const text = readFileSync(repoPath('contracts/openapi/internal-settlement-v1.yaml'), 'utf8');
  const start = text.indexOf('| `X-Service-Id` | Operaciones |');
  expect(start).toBeGreaterThan(-1);
  const rows = text.slice(start).split('\n').slice(2).filter((l) => l.trim().startsWith('|')).slice(0, 4);
  return rows.map((row) => {
    const [service, ops] = row.split('|').slice(1, 3).map((c) => c.trim());
    const name = /`(pay-[a-z]+)`/.exec(service)?.[1] as string;
    if (/todas/.test(ops)) return { service: name, operations: allOperations };
    return { service: name, operations: [...ops.matchAll(/`((?:GET|POST) [^`]+)`/g)].map((m) => m[1]) };
  });
}

const concrete = (op: string) => {
  const [method, template] = op.split(' ');
  const path = template
    .replace('/payouts/{id}', '/payouts/po_abcdefghijklmn')
    .replace('/reconciliation_runs/{id}', '/reconciliation_runs/rr_abcdefghijklmn')
    .replace('/reconciliation_exceptions/{id}/resolve', '/reconciliation_exceptions/rx_abcdefghijklmn/resolve');
  return { method, path: path === '/exports/accounting' ? `/exports/accounting?period_from=2026-10-01T00:00:00.000Z&period_to=${new Date(Date.now() - 5).toISOString()}` : path };
};

async function call(op: string, service: string, mode: string | null) {
  const { method, path } = concrete(op);
  let req = method === 'GET' ? ctx.as(service, mode).get(path) : ctx.as(service, mode).post(path, {});
  if (method === 'POST') req = req.set('idempotency-key', key());
  if (service === 'pay-edge') req = req.set('x-merchant-id', merchantId());
  // `resolve` revisa primero la credencial de la persona (401): con una válida se ejercita el modo.
  if (op.includes('/resolve')) req = req.set('authorization', `Bearer ${operatorToken(['settlement_admin'])}`);
  return req;
}

describe('llamadas entrantes que el contrato documenta', () => {
  let documented: Documented[];
  beforeAll(() => {
    documented = documentedCallers(ctx.settlementContract.operations().map((o) => o.replace(/\s+/, ' ')));
  });

  it('la tabla del contrato es la que se espera (si cambia, esta prueba lo avisa; no se asumen llamadores)', () => {
    const byService = Object.fromEntries(documented.map((d) => [d.service, d.operations.slice().sort()]));
    expect(Object.keys(byService).sort()).toEqual(['pay-console', 'pay-edge', 'pay-payments', 'pay-schedules']);
    expect(byService['pay-schedules']).toEqual(['GET /payouts', 'GET /payouts/{id}', 'POST /charges', 'POST /payouts']);
    expect(byService['pay-payments']).toEqual(['POST /charges']);
    expect(byService['pay-edge']).toEqual(['GET /payouts']);
    expect(byService['pay-console']).toHaveLength(ctx.settlementContract.operations().length);
  });

  it('cada par (servicio, operación) documentado: CON modo no es 403; SIN modo o con un valor inválido, 403 forbidden', async () => {
    const checkedPairs: string[] = [];
    for (const { service, operations } of documented) {
      for (const op of operations) {
        for (const mode of ['test', 'live'] as const) {
          const ok = await call(op, service, mode);
          expect([service, op, mode, ok.status === 403]).toEqual([service, op, mode, false]);
        }
        for (const bad of [null, '', 'TEST', 'sandbox', 'prod']) {
          const res = await call(op, service, bad);
          expect([service, op, bad, res.status, res.body.code]).toEqual([service, op, bad, 403, 'forbidden']);
        }
        checkedPairs.push(`${service} ${op}`);
      }
    }
    // 4 + 1 + 1 + 11 pares documentados
    expect(checkedPairs).toHaveLength(17);
  });

  it('un llamador NO documentado recibe 403 aunque mande un modo válido; no se agregan llamadores', async () => {
    const all = ctx.settlementContract.operations().map((o) => o.replace(/\s+/, ' '));
    const allowed = new Set(documented.flatMap((d) => d.operations.map((op) => `${d.service} ${op}`)));
    const strangers = ['pay-payments', 'pay-edge', 'pay-schedules', 'pay-merchants', 'pay-risk', 'pay-qr', 'pay-webhooks', 'pay-connectors'];
    for (const service of strangers) {
      for (const op of all) {
        if (allowed.has(`${service} ${op}`)) continue;
        const res = await call(op, service, 'test');
        expect([service, op, res.status]).toEqual([service, op, 403]);
      }
    }
  });
});
