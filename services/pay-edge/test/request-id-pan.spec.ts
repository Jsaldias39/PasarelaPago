import { startEdge, type EdgeHarness } from './harness';

/**
 * S-03: `X-Request-Id` se usa como `req.id` (log HTTP), como `request_id` de los problemas, en la cabecera de la respuesta y en la que se reenvía a los servicios dueños.
 * Uno con forma de número de tarjeta se descarta y se genera uno nuevo (mismo detector Luhn que el guardia de cuerpos). Tres niveles: CORRECTO, LÍMITE e INVÁLIDO.
 * Los números son los de PRUEBA públicos de las marcas.
 */
const BODY = '{"amount_minor":10000,"currency":"BOB","payment_method":{"type":"qr"}}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('pay-edge: X-Request-Id con forma de PAN', () => {
  let h: EdgeHarness;
  let token: string;
  const writes: string[] = [];
  const post = (requestId: string) =>
    h.http().post('/v1/payment_intents').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'cobro-mesa-12-2026-10-28').set('X-Request-Id', requestId).set('Content-Type', 'application/json').send(BODY);
  const forwarded = () => h.doubles['pay-payments'].requests;

  beforeAll(async () => {
    h = await startEdge({ env: { LOG_LEVEL: 'trace' }, logStream: { write: (line: string) => void writes.push(line) } });
    token = (await h.seedKey()).token;
  });
  afterAll(async () => {
    await h.stop();
  });
  afterEach(() => {
    forwarded().length = 0;
    writes.length = 0;
  });

  it('CORRECTO: un UUID y un id legible del cliente se conservan en la respuesta y se reenvían', async () => {
    for (const id of ['3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10', 'mi-id-de-correlacion-1']) {
      const res = await post(id);
      expect(res.status).toBe(201);
      expect(res.headers['x-request-id']).toBe(id);
      expect(String(forwarded().at(-1)!.headers['x-request-id'])).toBe(id);
    }
  });

  it.each([
    ['pelado', '4111111111111111'],
    ['con prefijo', 'req-4111111111111111'],
    ['con puntos y guiones bajos', '4111.1111_1111.1111'],
    ['Amex', '378282246310005'],
  ])('LÍMITE — %s: la petición PASA con un id nuevo; el PAN no se devuelve, ni se reenvía, ni queda en los logs', async (_name, id) => {
    const res = await post(id);
    expect(res.status).toBe(201);
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(String(forwarded().at(-1)!.headers['x-request-id'])).toBe(res.headers['x-request-id']);
    const digits = id.replace(/\D/g, '');
    expect(JSON.stringify(res.headers)).not.toContain(digits);
    expect(JSON.stringify(forwarded().map((r) => r.headers))).not.toContain(digits);
    expect(writes.join('')).not.toContain(digits);
  });

  it('INVÁLIDO: sin autenticar (el log corre antes) un id con forma de PAN tampoco llega a la respuesta de error ni al log', async () => {
    const res = await h.http().get('/v1/payment_intents').set('X-Request-Id', '4111111111111111');
    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(JSON.stringify(res.body)).not.toContain('4111111111111111');
    expect(res.body).toMatchObject({ request_id: res.headers['x-request-id'] });
    expect(writes.join('')).not.toContain('4111111111111111');
  });
});
