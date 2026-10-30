import request from 'supertest';
import { asPayments, asSettlement, chargeBody, createTestApp, uniqueKey, type TestApp } from './support/app';

// D-26 (contracts/openapi/common.yaml, `XPayModeSandbox`): en un despliegue sandbox TODA respuesta lleva `X-Pay-Mode: sandbox`; en live, ninguna.
// Es la cabecera de la RESPUESTA (el despliegue); la de la PETICIÓN (`test|live`, la clave: D-28) es otra y no se toca.
let sandbox: TestApp;
let live: TestApp;
beforeAll(async () => {
  sandbox = await createTestApp();
  live = await createTestApp({ config: { mode: 'live' } });
});
afterAll(async () => {
  await sandbox.close();
  await live.close();
});

const window = () => `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;

/** Un recorrido por todos los tipos de respuesta del servicio: éxito, errores del contrato, rechazos del guard, rutas inexistentes, salud, callbacks y extractos. */
const calls = (t: TestApp): Array<[string, () => request.Test]> => {
  const http = () => request(t.app.getHttpServer());
  return [
    ['GET /health/live', () => http().get('/health/live')],
    ['GET /health/ready', () => http().get('/health/ready')],
    ['POST /charges (201 en sandbox)', () => http().post('/charges').set(asPayments).set('idempotency-key', uniqueKey()).send(chargeBody({}, t.clock))],
    ['POST /charges sin cuerpo válido (422)', () => http().post('/charges').set(asPayments).set('idempotency-key', uniqueKey()).send({})],
    ['POST /charges sin identidad (403)', () => http().post('/charges').send({})],
    ['POST /charges con modo de clave live en sandbox (403)', () => http().post('/charges').set({ ...asPayments, 'x-pay-mode': 'live' }).set('idempotency-key', uniqueKey()).send(chargeBody({}, t.clock))],
    ['GET /charges/{id} inexistente (404)', () => http().get('/charges/ch_inexistente0001').set(asPayments)],
    ['ruta que no existe (404)', () => http().get('/no/existe').set(asPayments)],
    ['GET /connectors/health', () => http().get('/connectors/health').set(asPayments)],
    ['GET /statements (json)', () => http().get(`/statements?connector=mock&${window()}`).set(asSettlement)],
    ['GET /statements (csv)', () => http().get(`/statements?connector=mock&${window()}`).set(asSettlement).set('accept', 'text/csv')],
    ['GET /statements (xml)', () => http().get(`/statements?connector=mock&${window()}`).set(asSettlement).set('accept', 'application/xml')],
    ['POST /callbacks/mock con firma inválida (401)', () => http().post('/callbacks/mock').set('content-type', 'application/json').send('{"id":"x"}')],
  ];
};

describe('X-Pay-Mode: sandbox en las respuestas (pay-connectors)', () => {
  it('correcto/límite: en un despliegue sandbox TODA respuesta la lleva, con éxito o con error, y cada recorrido devuelve el estado esperado', async () => {
    const seen: Record<string, number> = {};
    for (const [name, send] of calls(sandbox)) {
      const response = await send();
      seen[name] = response.status;
      expect([name, response.headers['x-pay-mode']]).toEqual([name, 'sandbox']);
    }
    expect(seen).toMatchObject({ 'POST /charges (201 en sandbox)': 201, 'POST /charges sin cuerpo válido (422)': 422, 'POST /charges sin identidad (403)': 403, 'POST /charges con modo de clave live en sandbox (403)': 403, 'ruta que no existe (404)': 404, 'POST /callbacks/mock con firma inválida (401)': 401 });
  });

  it('inválido/límite: en un despliegue live NINGUNA respuesta la lleva (ni la salud, ni los errores)', async () => {
    for (const [name, send] of calls(live)) {
      const response = await send();
      expect([name, response.headers['x-pay-mode']]).toEqual([name, undefined]);
    }
  });

  it('la cabecera de la PETICIÓN no la cambia: una clave `test` y una `live` reciben la misma respuesta de despliegue (sandbox); un valor raro en la petición tampoco', async () => {
    for (const mode of ['test', 'live', 'sandbox', '', 'TEST']) {
      const response = await request(sandbox.app.getHttpServer()).get('/connectors/health').set({ 'x-service-id': 'pay-payments', 'x-pay-mode': mode });
      expect(response.headers['x-pay-mode']).toBe('sandbox');
    }
  });
});
