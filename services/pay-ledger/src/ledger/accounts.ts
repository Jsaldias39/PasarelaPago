/**
 * Plan de cuentas del ledger (PLAN-MAESTRO §3.3) y quién puede tocar cada tipo de cuenta.
 *
 * Las cuentas son lógicas: se crean la primera vez que una operación permitida las nombra. El patrón es el del contrato
 * (`internal-ledger-v1.yaml`, esquema `Account`).
 */

export type AccountKind =
  | 'merchant_pending'
  | 'merchant_available'
  | 'user_wallet'
  | 'platform_fees'
  | 'connector_clearing'
  | 'payout_clearing'
  | 'schedule_reserve';

export interface AccountInfo {
  readonly name: string;
  readonly kind: AccountKind;
  /** Lado en el que la cuenta tiene saldo «normal»: acreedora (el dinero es de alguien) o deudora (alguien nos debe). */
  readonly nature: 'credit' | 'debit';
  /** `true` si TigerBeetle impide que quede en negativo (`debits_must_not_exceed_credits`). */
  readonly limited: boolean;
  /** Comercio dueño de la cuenta, si lo hay. */
  readonly merchantId?: string;
}

const ACCOUNT_PATTERN =
  /^(?:merchant:(mc_[a-z0-9]{10,40}):(pending|available)|user:([A-Za-z0-9_-]{3,60}):wallet|platform:fees|connector:([a-z_]{3,30}):clearing|payout:clearing|schedule:(md_[a-z0-9]{10,40}):reserve)$/;

/**
 * Descompone una cuenta lógica.
 *
 * Decisión: `merchant:*:pending` también lleva la bandera de no-negativo. El plan marcaba solo `available`, `wallet` y la
 * reserva, pero liberar o reembolsar más de lo que hay pendiente sería crear dinero; ver DECISIONES-TOMADAS.md.
 *
 * @returns `null` si el nombre no es una cuenta del plan de cuentas.
 */
export function parseAccount(name: string): AccountInfo | null {
  const match = ACCOUNT_PATTERN.exec(name);
  if (!match) return null;
  if (match[1]) return { name, kind: match[2] === 'pending' ? 'merchant_pending' : 'merchant_available', nature: 'credit', limited: true, merchantId: match[1] };
  if (match[3]) return { name, kind: 'user_wallet', nature: 'credit', limited: true };
  if (name === 'platform:fees') return { name, kind: 'platform_fees', nature: 'credit', limited: false };
  if (match[4]) return { name, kind: 'connector_clearing', nature: 'debit', limited: false };
  if (name === 'payout:clearing') return { name, kind: 'payout_clearing', nature: 'debit', limited: false };
  return { name, kind: 'schedule_reserve', nature: 'credit', limited: true };
}

/**
 * Tipos de cuenta que cada servicio puede tocar (como débito o como crédito).
 *
 * Supuesto de la ola 1 (DECISIONES-TOMADAS.md D1, a confirmar con el dueño y contabilidad): el contrato dice que «el ledger valida
 * que el llamador esté autorizado para las cuentas que toca» pero no da la matriz. Esta es la más estrecha que alcanza para los
 * flujos del plan; un servicio que no figura no toca nada.
 */
const POLICY: Readonly<Record<string, readonly AccountKind[]>> = {
  // Cobros, reembolsos, billetera y comisión de cada cobro.
  'pay-payments': ['merchant_pending', 'merchant_available', 'user_wallet', 'platform_fees', 'connector_clearing'],
  // Liberación pending→available, payouts, abono mensual, comisión semanal y ajustes de conciliación.
  'pay-settlement': ['merchant_pending', 'merchant_available', 'platform_fees', 'payout_clearing', 'connector_clearing'],
  // Reserva de pagos programados (7.7 y 7.8).
  'pay-schedules': ['schedule_reserve', 'merchant_available', 'platform_fees'],
};

/** ¿Puede `caller` mover dinero desde o hacia una cuenta de este tipo? */
export function callerMayTouch(caller: string, kind: AccountKind): boolean {
  return POLICY[caller]?.includes(kind) ?? false;
}

/** Servicios que pueden llamar al ledger: la unión de la política (para `@AllowedServices`). */
export const LEDGER_CALLERS = Object.keys(POLICY);
