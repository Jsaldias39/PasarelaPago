import fs from 'node:fs';
import { startEdge, type EdgeHarness } from './harness';

/**
 * D-29: `payer_name` (nombre del pagador, dato personal) entra por `POST /v1/payment_intents`. El borde lo reenvía SIN tocarlo (no interpreta
 * cuerpos) y NUNCA lo repite: ni en sus respuestas ni en sus logs. El pan-guard sigue activo sobre el cuerpo completo, `payer_name` incluido.
 * Tres niveles: CORRECTO, LÍMITE e INVÁLIDO. Los nombres son sintéticos.
 */
const NAME = 'Andrés Ñandú Quispe-Núñez';
const body = (payerName: unknown, extra = '') => `{"amount_minor":10000,"currency":"BOB","payment_method":{"type":"qr"},"payer_name":${JSON.stringify(payerName)}${extra}}`;

describe('[DOBLE] payer_name en el borde', () => {
  let h: EdgeHarness;
  let token: string;
  /** pino escribe directo al descriptor 1 (no pasa por process.stdout.write): se intercepta fs.writeSync, que es lo que llega a la terminal. */
  const writes: string[] = [];
  let spy: jest.SpyInstance;

  const post = (text: string, key = 'clave-de-idempotencia-0001') =>
    h.http().post('/v1/payment_intents').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('Content-Type', 'application/json').send(text);
  const forwarded = () => h.doubles['pay-payments'].requests;

  beforeAll(async () => {
    // Nivel de log máximo: si el nombre se filtrara a algún log, saldría acá.
    h = await startEdge({ env: { LOG_LEVEL: 'trace' } });
    token = (await h.seedKey()).token;
    const real = fs.writeSync.bind(fs);
    spy = jest.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (fd === 1 || fd === 2) writes.push(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'));
      return (real as (...args: unknown[]) => number)(fd, data, ...rest);
    }) as typeof fs.writeSync);
  });
  afterAll(async () => {
    spy.mockRestore();
    await h.stop();
  });
  afterEach(() => {
    forwarded().length = 0;
    h.doubles['pay-payments'].override = undefined;
  });

  describe('nivel correcto', () => {
    it('lo reenvía al servicio dueño con los BYTES exactos (unicode incluido) y la respuesta no lo contiene', async () => {
      const text = body(NAME);
      const res = await post(text);
      expect(res.status).toBe(201);
      expect(forwarded()).toHaveLength(1);
      expect(forwarded()[0]!.body.equals(Buffer.from(text, 'utf8'))).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('Quispe');
      expect(res.body).not.toHaveProperty('payer_name');
      h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 201, body: res.body });
    });

    it('un cobro SIN payer_name (pagador invitado) pasa igual', async () => {
      const res = await post('{"amount_minor":10000,"currency":"BOB","payment_method":{"type":"qr"}}');
      expect(res.status).toBe(201);
      expect(forwarded()).toHaveLength(1);
    });

    it('la lectura del intento (GET) tampoco lo devuelve', async () => {
      const res = await h.http().get('/v1/payment_intents/pi_abcdefghij12').set('Authorization', `Bearer ${token}`);
      expect(JSON.stringify(res.body)).not.toMatch(/payer_name|Quispe/);
    });
  });

  describe('nivel límite', () => {
    it('200 caracteres (el máximo del contrato) y un nombre con escapes \\uXXXX pasan intactos', async () => {
      const long = 'N'.repeat(200);
      const escaped = String.raw`{"amount_minor":10000,"currency":"BOB","payment_method":{"type":"qr"},"payer_name":"José Núñez"}`;
      expect((await post(body(long))).status).toBe(201);
      expect((await post(escaped, 'clave-de-idempotencia-0002')).status).toBe(201);
      expect(forwarded()[1]!.body.equals(Buffer.from(escaped, 'utf8'))).toBe(true);
    });

    it('un nombre con dígitos que NO es un número de tarjeta pasa (el pan-guard no da falsos positivos con ruido corto)', async () => {
      expect((await post(body('Juan Pérez 2do'))).status).toBe(201);
      expect((await post(body('Local 12 piso 3'), 'clave-de-idempotencia-0003')).status).toBe(201);
    });

    it('PAN-GUARD ACTIVO: un payer_name que lleva un número de tarjeta se rechaza (422 card_number_detected), no llega al servicio y la respuesta no repite el nombre', async () => {
      const res = await post(body('Ana Prueba 4111 1111 1111 1111'));
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([{ field: 'body', code: 'card_number_detected', message: expect.any(String) }]);
      expect(JSON.stringify(res.body)).not.toMatch(/Ana|Prueba|4111/);
      expect(forwarded()).toHaveLength(0);
    });

    it('payer_name no es un parámetro de consulta: en un listado se rechaza (422 unknown_parameter) sin repetir el valor', async () => {
      const res = await h.http().get(`/v1/payment_intents?payer_name=${encodeURIComponent(NAME)}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toMatch(/Quispe|Ñandú/);
      expect(forwarded()).toHaveLength(0);
    });
  });

  describe('nivel inválido', () => {
    it('el borde no valida el tipo: lo reenvía y es el servicio dueño quien responde 422; el borde no repite el valor', async () => {
      h.doubles['pay-payments'].override = () => ({ status: 422, body: { type: 'about:blank', title: 'validation_failed', status: 422, code: 'validation_failed', request_id: 'x', errors: [{ field: 'payer_name', code: 'invalid_type' }] } });
      const res = await post(body(12345678));
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain('12345678');
    });

    it('si el servicio dueño cae (500), la respuesta del borde no contiene el nombre ni el cuerpo', async () => {
      h.doubles['pay-payments'].override = () => ({ status: 500, body: { type: 'about:blank', title: 'internal_error', status: 500, code: 'internal_error', request_id: 'x' } });
      const res = await post(body(NAME), 'clave-de-idempotencia-0004');
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).not.toMatch(/Quispe|Ñandú|payer_name/);
    });

    it('JSON roto con un payer_name adentro: 422 invalid_json sin eco', async () => {
      const res = await post(`{"payer_name":"${NAME}"`);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([{ field: 'body', code: 'invalid_json', message: expect.any(String) }]);
      expect(JSON.stringify(res.body)).not.toMatch(/Quispe|Ñandú/);
    });
  });

  it('NINGÚN log (nivel trace) contiene el nombre ni sus fragmentos, ni en los éxitos, ni en los rechazos, ni en los errores del servicio dueño', () => {
    const output = writes.join('');
    expect(output.length).toBeGreaterThan(0); // el log estuvo activo: la ausencia significa algo
    expect(output).not.toMatch(/Quispe|Ñandú|Andrés|Núñez|Jos\\u00e9|Ana Prueba|Juan Pérez|payer_name/);
  });
});
