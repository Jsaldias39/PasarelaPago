import { createTestContext, type TestContext } from './support/app';
import { bo } from './support/http';

/**
 * La ruta la escribe el cliente (la regla 90.2.2 le prohíbe poner datos ahí, pero puede equivocarse): ni la respuesta de error (`instance`) ni el
 * log de acceso repiten un PAN, un NIT ni una razón social que venga en el path. Mismo criterio que `pay-mockbank` (log-safe.ts).
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const PAN = '4111111111111111';
const NIT = '9988776655';
const NAME = 'RAZON-CENTINELA-URL SRL';

describe('la ruta que escribe el cliente no se refleja con datos', () => {
  it.each([
    ['PAN como id', `/merchants/${PAN}`],
    ['NIT dentro de un id', `/merchants/mc_${NIT}zzzz`],
    ['razón social y PAN en rutas inexistentes', `/${encodeURIComponent(NAME)}/${PAN}`],
  ])('%s: el 4xx no repite el dato y el log de acceso tampoco', async (_name, path) => {
    const res = await bo(ctx, 'get', path);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const logs = ctx.logs.join('\n');
    for (const secret of [PAN, NIT, 'RAZON-CENTINELA-URL']) {
      expect({ secret, enRespuesta: JSON.stringify(res.body).includes(secret) }).toEqual({ secret, enRespuesta: false });
      expect({ secret, enLogs: logs.includes(secret) }).toEqual({ secret, enLogs: false });
    }
  });

  it('control: una ruta normal conserva su `instance` completo', async () => {
    const res = await bo(ctx, 'get', '/merchants/mc_abcdefghij12');
    expect(res.status).toBe(404);
    expect(res.body.instance).toBe('/merchants/mc_abcdefghij12');
  });
});
