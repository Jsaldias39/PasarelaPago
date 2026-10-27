import type { LedgerConfig } from './ledger.config';

/** Un colaborador del ledger que puede ser real o un doble. Los reales se declaran con `isReal = true`; todo lo demás es un doble. */
export interface Collaborator {
  readonly isReal?: boolean;
}

/**
 * `PAY_MODE=live` se niega a arrancar con cualquier doble (D-26, decisión del coordinador de la ola 2): un ledger «live» sobre un motor que no
 * es TigerBeetle de verdad registraría dinero que no existe. En `sandbox` cualquier colaborador sirve.
 *
 * @throws Error con el nombre de cada doble y el motivo, para que quien despliega sepa qué cambiar.
 */
export function assertDeploymentSafe(config: Pick<LedgerConfig, 'payMode'>, collaborators: Readonly<Record<string, Collaborator>>): void {
  if (config.payMode !== 'live') return;
  const doubles = Object.entries(collaborators).filter(([, c]) => c.isReal !== true).map(([name]) => name);
  if (doubles.length > 0) {
    throw new Error(`PAY_MODE=live se niega a arrancar con dobles: ${doubles.join(', ')}. Un despliegue live solo usa colaboradores reales`);
  }
}
