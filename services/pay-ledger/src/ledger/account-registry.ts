import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AccountInfo } from './accounts';
import { accountTbId, toHex128 } from './ids';
import type { PayMode } from './mode';
import { TB_ENGINE, TigerBeetleEngine } from './tb-engine';

/** Crea las cuentas lógicas (de un modo) la primera vez que una operación permitida las nombra: en TigerBeetle y en la tabla de metadatos. */
@Injectable()
export class AccountRegistry {
  /**
   * Cuentas que este proceso ya vio CREADAS EN TIGERBEETLE, para no repetir el viaje. Perderlas solo cuesta una llamada idempotente.
   * Solo se memoriza lo confirmado en TigerBeetle, nunca lo escrito en Postgres: esa fila vive en la transacción del llamador y puede deshacerse.
   */
  private readonly known = new Set<string>();

  constructor(@Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine) {}

  async register(client: PoolClient, mode: PayMode, accounts: readonly AccountInfo[]): Promise<void> {
    const unique = [...new Map(accounts.map((a) => [a.name, a])).values()];
    const missing = unique.filter((a) => !this.known.has(`${mode}|${a.name}`));
    // Primero TigerBeetle (idempotente): si la transacción de Postgres se deshace, la cuenta solo queda creada de más.
    await this.tb.ensureAccounts(mode, missing);
    // La fila de Postgres se asegura SIEMPRE: otra petición concurrente pudo haber creado la cuenta en TigerBeetle sin haber confirmado todavía su
    // fila, y la clave foránea de las patas exige que esté confirmada. `ON CONFLICT DO NOTHING` espera a que la otra transacción termine.
    for (const account of unique) {
      await client.query(
        'INSERT INTO ledger_accounts (mode, account, kind, tb_id) VALUES ($1, $2, $3, $4) ON CONFLICT (mode, account) DO NOTHING',
        [mode, account.name, account.kind, toHex128(accountTbId(mode, account.name))],
      );
    }
    for (const account of missing) this.known.add(`${mode}|${account.name}`);
  }
}
