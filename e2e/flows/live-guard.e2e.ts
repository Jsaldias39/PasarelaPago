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

  it('pay-schedules no embebe ningún doble (su libro mayor es pay-ledger por HTTP): arranca en live, pero se niega con el interruptor de pruebas', async () => {
    const [withSwitch] = await bootUnderLive(['pay-schedules'], { 'pay-schedules': { DISABLE_BACKGROUND_JOBS: '1' } });
    expect({ healthy: withSwitch!.healthy, refusedByMode: refusedLive(withSwitch!) }).toEqual({ healthy: false, refusedByMode: true });
  });

  it('pay-ledger tampoco: el arnés le da un TigerBeetle REAL (privado), así que en live arranca; un doble del motor lo haría negarse (assertDeploymentSafe, probado en su carril)', async () => {
    const [ledger] = await bootUnderLive(['pay-ledger']);
    expect(ledger!.healthy).toBe(true);
  });
});
