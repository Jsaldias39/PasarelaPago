import type { Router } from 'express';
import { type SettlementTestContext, createSettlementContext } from './helpers/app';

let ctx: SettlementTestContext;
beforeAll(async () => {
  ctx = await createSettlementContext();
});
afterAll(async () => ctx.close());

/** Rutas realmente montadas en Express, normalizadas a `METHOD /ruta/{p}`. */
function mountedRoutes(): string[] {
  const instance = ctx.app.getHttpAdapter().getInstance() as { router?: Router; _router?: Router };
  const stack = ((instance.router ?? instance._router) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  const out: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${layer.route.path.replace(/:([A-Za-z_]+)/g, '{p}')}`);
  }
  return out.sort();
}
const normalize = (op: string) => op.replace(/\{[^}]+\}/g, '{p}');

describe('el servicio implementa el contrato interno de liquidación y nada más que lo propuesto', () => {
  it('cada operación de internal-settlement-v1.yaml tiene su ruta', () => {
    const routes = mountedRoutes();
    for (const op of ctx.settlementContract.operations()) expect(routes).toContain(normalize(op));
  });

  it('cada operación de public-v1.yaml que es de P2 (GET /payouts) tiene su ruta', () => {
    expect(mountedRoutes()).toContain('GET /payouts');
    expect(ctx.publicContract.operations()).toContain('GET /payouts');
  });

  it('las únicas rutas fuera del contrato son las dos PROPUESTAS declaradas (POST /charges, GET /exports/accounting)', () => {
    const contract = new Set(ctx.settlementContract.operations().map(normalize));
    const extra = mountedRoutes().filter((route) => !contract.has(route));
    expect(extra).toEqual(['GET /exports/accounting', 'POST /charges']);
  });

  it('toda ruta exige identidad de servicio: sin X-Service-Id válido ninguna responde distinto de 403', async () => {
    const calls: [string, string][] = [
      ['post', '/payouts'], ['get', '/payouts'], ['get', '/payouts/po_abcdefghijklmn'], ['post', '/batches'], ['get', '/batches'], ['post', '/reconciliation_runs'],
      ['get', '/reconciliation_runs/rr_abcdefghijklmn'], ['get', '/reconciliation_exceptions'], ['post', '/reconciliation_exceptions/rx_abcdefghijklmn/resolve'], ['post', '/charges'], ['get', '/exports/accounting'],
    ];
    const { default: request } = await import('supertest');
    for (const [method, path] of calls) {
      for (const id of [undefined, 'sin-formato', 'pay-desconocido']) {
        const req = (request(ctx.baseUrl) as unknown as Record<string, (p: string) => import('supertest').Test>)[method](path);
        if (id) req.set('x-service-id', id);
        expect([method, path, (await req).status]).toEqual([method, path, 403]);
      }
    }
  });
});
