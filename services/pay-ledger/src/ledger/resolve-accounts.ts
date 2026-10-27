import { ProblemError } from '@pay/problem';
import { type AccountInfo, callerMayTouch, parseAccount } from './accounts';

/**
 * Valida las cuentas de un movimiento y los permisos del llamador.
 *
 * @throws ProblemError 422 `validation_failed` (cuenta fuera del plan, o débito = crédito) o 403 `forbidden` (el servicio llamador
 *   no puede tocar ese tipo de cuenta). Nada se registra: no consume un intento.
 */
export function resolveAccounts(legs: readonly { debit_account: string; credit_account: string }[], caller: string): Map<string, AccountInfo> {
  const infos = new Map<string, AccountInfo>();
  legs.forEach((leg, index) => {
    if (leg.debit_account === leg.credit_account) {
      throw new ProblemError('validation_failed', { errors: [{ field: `legs.${index}`, code: 'same_account' }] });
    }
    for (const name of [leg.debit_account, leg.credit_account]) {
      const info = parseAccount(name);
      if (!info) throw new ProblemError('validation_failed', { errors: [{ field: `legs.${index}`, code: 'invalid_account' }] });
      if (!callerMayTouch(caller, info.kind)) throw new ProblemError('forbidden', { detail: 'El servicio llamador no puede tocar ese tipo de cuenta' });
      infos.set(name, info);
    }
  });
  return infos;
}
