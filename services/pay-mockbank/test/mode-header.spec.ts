import request from 'supertest';
import { asAdmin, asConnectors, chargeBody, createTestApp, type TestApp } from './support/app';

// D-26 / P4.H4.M5: en sandbox TODA respuesta lleva `X-Pay-Mode: sandbox` (contracts/openapi/common.yaml, XPayModeSandbox): éxitos, 403, 404, 422, 503, salud y rutas que no existen.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('X-Pay-Mode: sandbox en todas las respuestas', () => {
  it('éxito, error de validación, 403, 404 y 503', async () => {
    const http = () => request(t.app.getHttpServer());
    const responses = [
      await http().get('/health/live'),
      await http().get('/health/ready'),
      await http().post('/sandbox/charges').set(asConnectors).send(chargeBody({}, t.clock) as object), // 201
      await http().post('/sandbox/charges').set(asConnectors).send({}), // 422
      await http().post('/sandbox/charges').send({}), // 403 sin identidad
      await http().get('/sandbox/charges/ch_nuncacreadoxxxx').set(asConnectors), // 404 del banco
      await http().get('/ruta/que/no/existe').set(asConnectors), // 404 de Nest
      await http().post('/sandbox/admin/reset').set(asAdmin),
      await http().post('/sandbox/charges').set(asConnectors).send(chargeBody({ amount_minor: 10006 }, t.clock) as object), // 503 banco caído
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 201, 422, 403, 404, 404, 200, 503]);
    for (const response of responses) expect(response.headers['x-pay-mode']).toBe('sandbox');
  });

  it('los extractos CSV y camt.053 también la llevan, y una petición con `X-Pay-Mode: live` no la cambia a otra cosa', async () => {
    const q = `from=${new Date(0).toISOString()}&to=${new Date().toISOString()}`;
    for (const format of ['csv', 'camt053', 'json']) {
      const response = await request(t.app.getHttpServer()).get(`/sandbox/statement?${q}&format=${format}`).set(asConnectors);
      expect(response.status).toBe(200);
      expect(response.headers['x-pay-mode']).toBe('sandbox');
    }
    const live = await request(t.app.getHttpServer()).get(`/sandbox/statement?${q}`).set({ ...asConnectors, 'x-pay-mode': 'live' });
    expect(live.status).toBe(403);
    expect(live.headers['x-pay-mode']).toBe('sandbox');
  });
});
