import type { PayoutRail } from './ports';

const isReal = (collaborator: object): boolean => (collaborator as { isReal?: boolean }).isReal === true;
import type { SettlementConfig } from './settlement.config';

/**
 * `PAY_MODE=live` se niega a arrancar con cualquier doble o conector mock (D-26, decisión del coordinador de la ola 2): un `pay-settlement` live
 * que «paga» por un riel simulado marcaría como pagado lo que nunca salió. Los colaboradores reales se declaran con `isReal = true`; todo lo
 * demás es un doble. En `sandbox` cualquier colaborador sirve.
 *
 * @throws Error con el nombre de cada doble y el motivo, para que quien despliega sepa qué cambiar.
 */
export function assertDeploymentSafe(
  config: Pick<SettlementConfig, 'payMode' | 'mode' | 'transferConnector'>,
  collaborators: { readonly ledger: object; readonly connectors: object; readonly rail: Pick<PayoutRail, 'code' | 'simulated'> },
): void {
  if (config.payMode !== 'live') return;
  const doubles: string[] = [];
  if (!isReal(collaborators.ledger)) doubles.push('cliente del ledger');
  if (!isReal(collaborators.connectors)) doubles.push('cliente de conectores');
  if (collaborators.rail.simulated) doubles.push(`riel ${collaborators.rail.code}`);
  if (config.mode === 'acquirer') doubles.push('settlement.mode=acquirer (modo B)');
  if (config.transferConnector === 'mock') doubles.push('conector mock');
  if (doubles.length > 0) throw new Error(`PAY_MODE=live se niega a arrancar con dobles: ${doubles.join(', ')}. Un despliegue live solo usa colaboradores reales`);
}
