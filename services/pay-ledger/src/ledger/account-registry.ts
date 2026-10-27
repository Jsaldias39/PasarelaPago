import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AccountInfo } from './accounts';
import { accountTbId, toHex128 } from './ids';
import { TB_ENGINE, TigerBeetleEngine } from './tb-engine';

/** Crea las cuentas lógicas la primera vez que una operación permitida las nombra: en TigerBeetle y en la tabla de metadatos. */
@Injectable()
export class AccountRegistry {
  /** Cuentas que este proceso ya vio creadas, para no repetir el viaje a TigerBeetle. Perderlas solo cuesta una llamada idempotente. */
  private readonly known = new Set<string>();

  constructor(@Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine) {}

  async register(client: PoolClient, accounts: readonly AccountInfo[]): Promise<void> {
    const missing = [...new Map(accounts.map((a) => [a.name, a])).values()].filter((a) => !this.known.has(a.name));
    if (missing.length === 0) return;
    // Primero TigerBeetle (idempotente): si la transacción de Postgres se deshace, la cuenta solo queda creada de más.
    await this.tb.ensureAccounts(missing);
    for (const account of missing) {
      await client.query(
        'INSERT INTO ledger_accounts (account, kind, tb_id) VALUES ($1, $2, $3) ON CONFLICT (account) DO NOTHING',
        [account.name, account.kind, toHex128(accountTbId(account.name))],
      );
    }
    // Solo se memoriza lo que ya está confirmado en TigerBeetle; el insert en Postgres es idempotente.
    for (const account of missing) this.known.add(account.name);
  }
}
