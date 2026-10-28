import { startEdge, type EdgeHarness } from './harness';

/**
 * La `Idempotency-Key` se guarda EN CLARO aguas abajo (`idempotency_keys`) y viaja en cabeceras entre servicios: una con forma de número de tarjeta se reenvía como
 * su hash (`masked-<sha256>`), nunca tal cual (regla del repo: el PAN no existe en ningún lado). NO se rechaza: un falso positivo tiraría peticiones legítimas
 * (ver `safeIdempotencyKey`). Tres niveles: CORRECTO, LÍMITE e INVÁLIDO. Los números son los de PRUEBA públicos de las marcas.
 */
const BODY = '{"amount_minor":10000,"currency":"BOB","payment_method":{"type":"qr"}}';

describe('pay-edge: Idempotency-Key con forma de PAN', () => {
  let h: EdgeHarness;
  let token: string;
  const writes: string[] = [];
  const post = (key: string) => h.http().post('/v1/payment_intents').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('Content-Type', 'application/json').send(BODY);
  const forwarded = () => h.doubles['pay-payments'].requests;
  const forwardedKey = () => String(forwarded().at(-1)!.headers['idempotency-key']);

  beforeAll(async () => {
    h = await startEdge({ env: { LOG_LEVEL: 'trace' }, logStream: { write: (line: string) => void writes.push(line) } });
    token = (await h.seedKey()).token;
  });
  afterAll(async () => {
    await h.stop();
  });
  afterEach(() => {
    forwarded().length = 0;
  });

  it('CORRECTO: un UUID y una clave legible se reenvían tal cual', async () => {
    for (const key of ['3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10', 'cobro-mesa-12-2026-10-28']) {
      expect((await post(key)).status).toBe(201);
      expect(forwardedKey()).toBe(key);
    }
    expect(forwarded()).toHaveLength(2);
  });

  it.each([
    ['pelado', '4111111111111111'],
    ['con guiones', '4111-1111-1111-1111'],
    ['con prefijo', 'orden-4111111111111111'],
    ['Amex', '378282246310005'],
    ['con puntos y guiones bajos', '4111.1111_1111.1111'],
    ['con separadores raros', '4111+1111:1111;1111'],
  ])('LÍMITE — %s: la petición PASA, pero al servicio dueño llega masked-<sha256>; el PAN no se reenvía ni se repite en la respuesta ni en los logs', async (_name, key) => {
    const res = await post(key);
    expect(res.status).toBe(201);
    expect(forwardedKey()).toMatch(/^masked-[0-9a-f]{64}$/);
    const digits = key.replace(/\D/g, '');
    expect(JSON.stringify(forwarded().map((r) => r.headers))).not.toContain(digits);
    expect(JSON.stringify(res.body)).not.toContain(digits);
    expect(writes.join('')).not.toMatch(/4111|378282246310005/);
  });

  it('LÍMITE: la misma clave con forma de PAN se reenvía SIEMPRE como el mismo hash (la idempotencia aguas abajo sigue funcionando)', async () => {
    await post('4111111111111111');
    await post('4111111111111111');
    expect(forwarded()).toHaveLength(2);
    expect(String(forwarded()[0]!.headers['idempotency-key'])).toBe(String(forwarded()[1]!.headers['idempotency-key']));
  });

  it('INVÁLIDO: una clave que ya fallaba por formato sigue dando invalid_format (sin cambiar el contrato anterior)', async () => {
    const res = await post('corta');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ errors: [{ field: 'idempotency-key', code: 'invalid_format' }] });
    expect(forwarded()).toHaveLength(0);
  });
});
