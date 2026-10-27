import {
  AccountFlags,
  CreateAccountStatus,
  CreateTransferStatus,
  TransferFlags,
  createClient,
  type Account,
  type Client,
  type Transfer,
} from 'tigerbeetle-node';
import { ProblemError } from '@pay/problem';
import type { AccountInfo, AccountKind } from './accounts';
import { accountTbId } from './ids';
import type { LedgerConfig } from './ledger.config';

/** Ledger 1 de TigerBeetle = bolivianos (D-06: solo BOB en v1). */
export const LEDGER_BOB = 1;

const ACCOUNT_CODE: Record<AccountKind, number> = {
  merchant_pending: 1,
  merchant_available: 2,
  user_wallet: 3,
  platform_fees: 4,
  connector_clearing: 5,
  payout_clearing: 6,
  schedule_reserve: 7,
  merchant_debt: 8,
};

/** Códigos de movimiento (`Leg.code` del contrato) como enteros de TigerBeetle. */
export const LEG_CODES = ['charge', 'fee', 'refund', 'payout', 'release', 'wallet_transfer', 'mandate', 'adjustment'] as const;
export type LegCode = (typeof LEG_CODES)[number];
const TRANSFER_CODE = Object.fromEntries(LEG_CODES.map((code, index) => [code, index + 1])) as Record<LegCode, number>;

export interface PlainTransfer {
  readonly id: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly amount: bigint;
  readonly code: LegCode;
}

function base(id: bigint, debit: bigint, credit: bigint, amount: bigint, code: number): Transfer {
  return {
    id,
    debit_account_id: debit,
    credit_account_id: credit,
    amount,
    pending_id: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    timeout: 0,
    ledger: LEDGER_BOB,
    code,
    flags: 0,
    timestamp: 0n,
  };
}

/** Pata de un asiento. `linked` encadena con la siguiente: o se aplican todas o ninguna. */
export function plainTransfer(t: PlainTransfer, linked: boolean): Transfer {
  return { ...base(t.id, t.debit, t.credit, t.amount, TRANSFER_CODE[t.code]), flags: linked ? TransferFlags.linked : 0 };
}

/** Primera fase: reserva `amount` sin moverlo; vuelve solo a la cuenta de origen pasados `timeoutSeconds`. */
export function pendingTransfer(t: PlainTransfer, timeoutSeconds: number): Transfer {
  return { ...base(t.id, t.debit, t.credit, t.amount, TRANSFER_CODE[t.code]), flags: TransferFlags.pending, timeout: timeoutSeconds };
}

/** Segunda fase: confirma la retención (`amount` ≤ retenido; el resto vuelve a la cuenta de origen). */
export function postPendingTransfer(id: bigint, pendingId: bigint, t: PlainTransfer): Transfer {
  return { ...base(id, t.debit, t.credit, t.amount, TRANSFER_CODE[t.code]), pending_id: pendingId, flags: TransferFlags.post_pending_transfer };
}

/** Segunda fase: anula la retención. */
export function voidPendingTransfer(id: bigint, pendingId: bigint, t: PlainTransfer): Transfer {
  return { ...base(id, t.debit, t.credit, 0n, TRANSFER_CODE[t.code]), pending_id: pendingId, flags: TransferFlags.void_pending_transfer };
}

/** Nombre legible de un estado de TigerBeetle (para el rastro de rechazos; no lleva datos personales). */
export function transferStatusName(status: number): string {
  return CreateTransferStatus[status] ?? `desconocido_${status}`;
}

/**
 * Cliente de TigerBeetle de larga vida (uno por proceso; el tope del servidor es 32 clientes, hallazgo H-4).
 *
 * Cada llamada lleva su propio *timeout* (H-5): un `cluster_id` equivocado no da error, simplemente no responde, y el cliente
 * reintenta para siempre. Un timeout NO significa que no se aplicó: por eso todos los ids son deterministas y reintentar el
 * mismo (business_ref, attempt) devuelve `exists` en vez de duplicar.
 */
export class TigerBeetleEngine {
  private readonly client: Client;

  constructor(private readonly config: LedgerConfig['tb']) {
    this.client = createClient({ cluster_id: config.clusterId, replica_addresses: [config.address] });
  }

  private async bounded<T>(operation: string, call: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProblemError('ledger_unavailable', { detail: `TigerBeetle no respondió a ${operation} en ${this.config.timeoutMs} ms` })), this.config.timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Crea las cuentas que falten. Es idempotente: una cuenta que ya existe con las mismas banderas no es un error. */
  async ensureAccounts(accounts: readonly AccountInfo[]): Promise<void> {
    if (accounts.length === 0) return;
    const batch: Account[] = accounts.map((info) => ({
      id: accountTbId(info.name),
      debits_pending: 0n,
      debits_posted: 0n,
      credits_pending: 0n,
      credits_posted: 0n,
      user_data_128: 0n,
      user_data_64: 0n,
      user_data_32: 0,
      reserved: 0,
      ledger: LEDGER_BOB,
      code: ACCOUNT_CODE[info.kind],
      // Acreedora: no puede quedar en negativo. Deudora (la deuda del comercio): no puede pagarse de más.
      flags: !info.limited ? 0 : info.nature === 'credit' ? AccountFlags.debits_must_not_exceed_credits : AccountFlags.credits_must_not_exceed_debits,
      timestamp: 0n,
    }));
    const results = await this.bounded('createAccounts', this.client.createAccounts(batch));
    results.forEach((result, index) => {
      if (result.status !== CreateAccountStatus.created && result.status !== CreateAccountStatus.exists) {
        throw new Error(`TigerBeetle rechazó crear la cuenta ${accounts[index].kind}: ${CreateAccountStatus[result.status] ?? result.status}`);
      }
    });
  }

  /** Aplica el lote. Devuelve un estado por transferencia, en el mismo orden. */
  async createTransfers(batch: readonly Transfer[]): Promise<number[]> {
    const results = await this.bounded('createTransfers', this.client.createTransfers([...batch]));
    return results.map((result) => result.status as number);
  }

  /** Cuentas por id; las que no existen no aparecen. */
  async lookupAccounts(ids: readonly bigint[]): Promise<Account[]> {
    if (ids.length === 0) return [];
    return this.bounded('lookupAccounts', this.client.lookupAccounts([...ids]));
  }

  /** Lectura barata para el readiness: pide una cuenta que no existe. */
  async ping(): Promise<void> {
    await this.lookupAccounts([1n]);
  }

  destroy(): void {
    this.client.destroy();
  }
}

export const TB_ENGINE = Symbol('TB_ENGINE');
export { CreateTransferStatus };
