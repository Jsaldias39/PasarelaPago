import type { ConnectorsClient } from './clients/connectors.client';
import type { PayMode } from './config';

/**
 * Guarda de arranque (decisión del coordinador, D-26): bajo `PAY_MODE=live` el servicio se NIEGA a arrancar si detrás hay un doble o un
 * conector `mock`/`sandbox`. Se pregunta a `pay-connectors` por su salud (`GET /connectors/health`, contrato) y se falla CERRADO: si no
 * contesta o contesta algo ilegible tampoco se arranca, porque no se puede probar que no hay un simulador. En `sandbox` no hace nada.
 * (`pay-vault` aplica la suya en su configuración: `FakeVaultBackend` está prohibido en `live`.)
 */
export async function assertNoDoublesInLive(payMode: PayMode, connectors: Pick<ConnectorsClient, 'getHealth'>): Promise<void> {
  if (payMode !== 'live') return;
  let health;
  try {
    health = await connectors.getHealth();
  } catch (error) {
    throw new Error(`PAY_MODE=live: no se pudo verificar que pay-connectors no tiene conectores «mock» o «sandbox» (${(error as Error).name}); pay-payments se niega a arrancar`);
  }
  if (health.length === 0) throw new Error('PAY_MODE=live: pay-connectors no informa ningún conector; pay-payments se niega a arrancar');
  const offenders = health.filter((entry) => entry.connector === 'mock' || entry.mode !== 'live').map((entry) => `${entry.connector} (${entry.mode})`);
  if (offenders.length > 0) throw new Error(`PAY_MODE=live: pay-connectors tiene conectores de simulación o sandbox: ${offenders.join(', ')}; pay-payments se niega a arrancar`);
}
