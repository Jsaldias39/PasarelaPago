import { changeMerchantStatus, seedMerchant, waitForEdgeToKnow, type MerchantTransition, type SeededMerchant } from '../lib/seed.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * D-32 con procesos reales (pay-merchants → outbox → NATS → réplica de pay-edge → petición pública):
 * cerrar un comercio REVOCA sus claves (401 en menos de 5 s); suspender solo las BLOQUEA (403 merchant_suspended) y reactivar las
 * RESTAURA (200). La acción del operador es un [DOBLE] (changeMerchantStatus): hace lo mismo que MerchantsService, que sí se prueba
 * en su carril. La observación es siempre la petición pública `GET /v1/merchants/me` con la clave `sk_test_` del comercio.
 */
const FIVE_SECONDS = 5_000;

describe('D-32 — ciclo de vida de las claves de un comercio, observado en el borde real', () => {
  let stack: Stack;

  const me = async (merchant: SeededMerchant) => (await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } })).status;
  const newMerchant = async (label: string) => {
    const merchant = await seedMerchant(stack, { label });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    expect(await me(merchant)).toBe(200);
    return merchant;
  };
  /** Aplica la transición y mide cuánto tarda el borde en mostrar el estado esperado. */
  const transition = async (merchant: SeededMerchant, kind: MerchantTransition, expected: number, options: { announceKeyRevocations?: boolean } = {}) => {
    const started = Date.now();
    await changeMerchantStatus(stack, merchant, kind, options);
    await until(`el borde responde ${expected} tras «${kind}»`, () => me(merchant), (status) => status === expected, 20_000, 50);
    return Date.now() - started;
  };

  beforeAll(async () => {
    stack = await startStack({ only: ['pay-merchants', 'pay-edge'], tolerateFailures: false });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack)).leftoverPids).toEqual([]);
  });

  describe('nivel correcto', () => {
    it('suspender BLOQUEA (403 merchant_suspended) y reactivar RESTAURA (200), ambos en menos de 5 s', async () => {
      const merchant = await newMerchant('COMERCIO D32 SUSPENDIDO (SINTÉTICO)');
      expect(await transition(merchant, 'suspend', 403)).toBeLessThan(FIVE_SECONDS);
      const blocked = await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } });
      expect(blocked.json).toMatchObject({ code: 'merchant_suspended', status: 403 });
      expect(await transition(merchant, 'reactivate', 200)).toBeLessThan(FIVE_SECONDS);
    });

    it('cerrar REVOCA la clave: 401 indistinguible de una clave inexistente, en menos de 5 s', async () => {
      const merchant = await newMerchant('COMERCIO D32 CERRADO (SINTÉTICO)');
      expect(await transition(merchant, 'close', 401)).toBeLessThan(FIVE_SECONDS);
      const closed = await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } });
      const unknown = await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: 'Bearer sk_test_nokeynokeyno_00000000000000000000000000000000' } });
      expect(closed.json).toMatchObject({ code: 'unauthorized', status: 401 });
      expect({ code: (closed.json as { code: string }).code }).toEqual({ code: (unknown.json as { code: string }).code });
    });
  });

  describe('nivel límite', () => {
    it('si solo llega merchant.closed (sin la revocación por clave) la clave igual deja de servir', async () => {
      const merchant = await newMerchant('COMERCIO D32 SOLO CLOSED (SINTÉTICO)');
      expect(await transition(merchant, 'close', 401, { announceKeyRevocations: false })).toBeLessThan(FIVE_SECONDS);
    });

    it('cerrado es terminal: reactivar un comercio cerrado no devuelve la clave', async () => {
      const merchant = await newMerchant('COMERCIO D32 TERMINAL (SINTÉTICO)');
      await transition(merchant, 'close', 401);
      await changeMerchantStatus(stack, merchant, 'reactivate');
      // Condición, no espera fija: otro comercio sembrado DESPUÉS ya se ve en el borde ⇒ el evento de reactivación (publicado antes) también se procesó.
      await newMerchant('COMERCIO D32 MARCADOR (SINTÉTICO)');
      expect(await me(merchant)).toBe(401);
    });

    it('suspender o cerrar un comercio no toca las claves de otro', async () => {
      const [a, b] = [await newMerchant('COMERCIO D32 A (SINTÉTICO)'), await newMerchant('COMERCIO D32 B (SINTÉTICO)')];
      await transition(a, 'suspend', 403);
      await transition(a, 'close', 401);
      expect(await me(b)).toBe(200);
    });
  });

  describe('nivel inválido', () => {
    it('una clave de un comercio cerrado no se distingue por el borde ni autentica con el prefijo de otro modo', async () => {
      const merchant = await newMerchant('COMERCIO D32 INVÁLIDO (SINTÉTICO)');
      await transition(merchant, 'close', 401);
      const asLive = merchant.token.replace('sk_test_', 'sk_live_');
      const res = await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${asLive}` } });
      expect(res.status).toBe(401);
    });
  });
});
