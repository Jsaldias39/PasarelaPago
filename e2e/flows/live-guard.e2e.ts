import { bootUnderLive, refusedLive } from '../lib/live-guard.ts';
import type { ServiceName } from '../lib/services.ts';

/**
 * Servicios que, con el entorno de sandbox del arnés (conector `mock`, `VAULT_BACKEND=fake`, destinos y CA de sandbox, rail `mock`,
 * listas de Watchman congeladas, GUID de QR provisional, destinos en loopback…), se niegan a arrancar con `PAY_MODE=live`.
 */
const HOLD_DOUBLES: readonly ServiceName[] = ['pay-vault', 'pay-merchants', 'pay-webhooks', 'pay-connectors', 'pay-payments', 'pay-settlement', 'pay-edge', 'pay-qr', 'pay-risk'];

describe('guardia de modo — PAY_MODE=live con el conector mock y los dobles de sandbox NO arranca (P1.H5.M5)', () => {
  it('cada servicio que recibe un doble de sandbox termina en vez de quedar sano, y el registro nombra PAY_MODE=live', async () => {
    const results = await bootUnderLive(HOLD_DOUBLES);
    for (const result of results) {
      expect({ service: result.service, healthy: result.healthy, refusedByMode: refusedLive(result) }).toEqual({ service: result.service, healthy: false, refusedByMode: true });
    }
  });

  describe('pay-webhooks: el motor de entrega propio es un doble de Svix (WEBHOOKS_ENGINE)', () => {
    /** Se le quitan los destinos y la CA de sandbox para aislar la guardia del motor de las otras. */
    const withoutSandboxLeftovers = { WEBHOOKS_SANDBOX_TARGETS: null, WEBHOOKS_SANDBOX_CA_FILE: null };
    it.each([
      ['sin declarar el motor', {}, /PAY_MODE=live exige declarar WEBHOOKS_ENGINE/],
      ['con inprocess (el doble)', { WEBHOOKS_ENGINE: 'inprocess' }, /no admite WEBHOOKS_ENGINE=inprocess/],
      // SvixEngine existe desde la ola 5 (P1.H3.M1): con svix, live exige el servidor y su token validados al arrancar, y https.
      ['con svix sin WEBHOOKS_SVIX_URL', { WEBHOOKS_ENGINE: 'svix' }, /WEBHOOKS_SVIX_URL/],
      ['con svix por http', { WEBHOOKS_ENGINE: 'svix', WEBHOOKS_SVIX_URL: 'http://svix.example:8071' }, /WEBHOOKS_SVIX_URL debe ser https con PAY_MODE=live/],
    ])('live %s ⇒ no arranca y el mensaje lo dice', async (_name, env, message) => {
      const [result] = await bootUnderLive(['pay-webhooks'], { 'pay-webhooks': { ...withoutSandboxLeftovers, ...env } });
      expect({ healthy: result!.healthy, refusedByMode: result!.log.match(message) !== null }).toEqual({ healthy: false, refusedByMode: true });
    });
  });

  it('pay-schedules no embebe ningún doble (su libro mayor es pay-ledger por HTTP): arranca en live, pero se niega con el interruptor de pruebas', async () => {
    const [withSwitch] = await bootUnderLive(['pay-schedules'], { 'pay-schedules': { DISABLE_BACKGROUND_JOBS: '1' } });
    expect({ healthy: withSwitch!.healthy, refusedByMode: refusedLive(withSwitch!) }).toEqual({ healthy: false, refusedByMode: true });
  });

  it('S-02: sin IDEMPOTENCY_MASK_KEY ningún servicio que usa el almacén de idempotencia arranca en live, y el registro dice qué falta', async () => {
    const services = ['pay-ledger', 'pay-schedules'] as const;
    const results = await bootUnderLive(services, Object.fromEntries(services.map((name) => [name, { IDEMPOTENCY_MASK_KEY: null }])));
    for (const result of results) {
      expect({ service: result.service, healthy: result.healthy, named: /IDEMPOTENCY_MASK_KEY es obligatoria bajo PAY_MODE=live/.test(result.log) }).toEqual({ service: result.service, healthy: false, named: true });
    }
  });

  it('pay-ledger tampoco: el arnés le da un TigerBeetle REAL (privado), así que en live arranca; un doble del motor lo haría negarse (assertDeploymentSafe, probado en su carril)', async () => {
    const [ledger] = await bootUnderLive(['pay-ledger']);
    expect(ledger!.healthy).toBe(true);
  });
});
