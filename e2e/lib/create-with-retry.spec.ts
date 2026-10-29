import { createWithRetry, type RetryResponse } from './sandbox-seed.ts';

/**
 * Política de reintento de la siembra. Regla 11: un resultado ambiguo (401/404/409/5xx) se reintenta con la MISMA Idempotency-Key. Pero un 422 es un rechazo
 * determinista que @pay/idempotency guarda y repite 24 h bajo esa clave: reintentarlo con la misma clave nunca converge (defecto hallado en la suite completa,
 * cuando la réplica de comercios de pay-schedules aún no conocía al beneficiario).
 */
const created: RetryResponse = { status: 201, json: { id: 'mnd_1' } };
const rejected: RetryResponse = { status: 422, json: { code: 'validation_failed', errors: [{ field: 'beneficiary_merchant_id', code: 'unknown' }] } };

/** Un servidor con idempotencia real: los rechazos de negocio del handler (422/400) se guardan y se repiten por clave, como @pay/idempotency; 401/404/409 de borde o «en curso» no. */
function idempotentServer(script: RetryResponse[]) {
  const stored = new Map<string, RetryResponse>();
  const keys: string[] = [];
  let call = 0;
  return {
    keys,
    send: async (key: string): Promise<RetryResponse> => {
      keys.push(key);
      const replay = stored.get(key);
      if (replay) return replay;
      const res = script[Math.min(call, script.length - 1)]!;
      call += 1;
      if (res.status === 422 || res.status === 400) stored.set(key, res);
      return res;
    },
  };
}

const run = (server: ReturnType<typeof idempotentServer>, timeoutMs = 60_000, clock = { t: 0 }) =>
  createWithRetry({ send: server.send, idempotencyKey: 'base', pause: async (ms) => void (clock.t += ms), timeoutMs, now: () => clock.t });

describe('createWithRetry', () => {
  it('correcto: 201 a la primera, una sola llamada con la clave original', async () => {
    const server = idempotentServer([created]);
    await expect(run(server)).resolves.toBe('mnd_1');
    expect(server.keys).toEqual(['base']);
  });

  it('correcto: un 422 transitorio (réplica atrasada) converge con una clave derivada, aunque el servidor repita los 422 por clave', async () => {
    const server = idempotentServer([rejected, rejected, created]);
    await expect(run(server)).resolves.toBe('mnd_1');
    expect(server.keys).toEqual(['base', 'base~r1', 'base~r2']);
  });

  it('límite (regla 11): ante 5xx, 401, 404 o 409 se reintenta con la MISMA clave, nunca con una derivada', async () => {
    for (const status of [500, 502, 401, 404, 409]) {
      const server = idempotentServer([{ status, json: {} }, created]);
      await expect(run(server)).resolves.toBe('mnd_1');
      expect(server.keys).toEqual(['base', 'base']);
    }
  });

  it('inválido: un 422 que no se resuelve agota el plazo y falla con el cuerpo completo del error', async () => {
    const server = idempotentServer([rejected]);
    await expect(run(server, 5_000)).rejects.toThrow(/respondió 422.*beneficiary_merchant_id.*unknown/s);
    expect(server.keys.length).toBeGreaterThan(1);
  });

  it('inválido: un 400 no se reintenta', async () => {
    const server = idempotentServer([{ status: 400, json: { code: 'bad_request' } }]);
    await expect(run(server)).rejects.toThrow(/respondió 400/);
    expect(server.keys).toEqual(['base']);
  });
});
