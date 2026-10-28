import { createTestContext, type TestContext } from './support/app';
import { newMerchant, pub } from './support/http';

/** Ver pay-merchants/test/url-privacy.spec.ts: la ruta del cliente no se refleja con datos en `instance` ni en el log de acceso. */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const PAN = '4111111111111111';
const NAME = 'RAZON-CENTINELA-URL SRL';

describe('la ruta que escribe el cliente no se refleja con datos', () => {
  it.each([
    ['PAN como id de mandato', `/mandates/${PAN}`],
    ['nombre en un id', `/mandates/md_${'RAZON-CENTINELA-URL'.toLowerCase().replace(/[^a-z0-9]/g, '')}`],
    ['razón social y PAN en una ruta inexistente', `/${encodeURIComponent(NAME)}/${PAN}`],
  ])('%s: el 4xx no repite el dato y el log de acceso tampoco', async (_name, path) => {
    const res = await pub(ctx, 'delete', path, newMerchant());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const logs = ctx.logs.join('\n');
    for (const secret of [PAN, 'RAZON-CENTINELA', 'razoncentinelaurl']) {
      expect({ secret, enRespuesta: JSON.stringify(res.body).includes(secret) }).toEqual({ secret, enRespuesta: false });
      expect({ secret, enLogs: logs.includes(secret) }).toEqual({ secret, enLogs: false });
    }
  });

  it('control: una ruta normal conserva su `instance` completo', async () => {
    const res = await pub(ctx, 'delete', '/mandates/md_abcdefghij12', newMerchant());
    expect(res.status).toBe(404);
    expect(res.body.instance).toBe('/mandates/md_abcdefghij12');
  });
});
