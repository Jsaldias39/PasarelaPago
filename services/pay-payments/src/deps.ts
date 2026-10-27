import type { PoolLike } from '@pay/idempotency';
import { ConnectorsClient } from './clients/connectors.client';
import { HttpClient } from './clients/http';
import { LedgerClient } from './clients/ledger.client';
import { RiskClient } from './clients/risk.client';
import { VaultClient } from './clients/vault.client';
import { DisabledWalletAuthorizer, type WalletAuthorizer } from './clients/wallet-authorizer';
import type { ServiceConfig } from './config';
import { txRunner, type TxRunner } from './persistence/db';

/** Todo lo que necesitan las activities y los servicios: se arma una vez y se inyecta (así las pruebas ponen dobles). */
export interface Deps {
  readonly pool: PoolLike;
  readonly tx: TxRunner;
  readonly config: ServiceConfig;
  readonly clients: { readonly risk: RiskClient; readonly connectors: ConnectorsClient; readonly ledger: LedgerClient; readonly vault: VaultClient };
  readonly wallet: WalletAuthorizer;
  readonly now: () => Date;
}

const SERVICE_ID = 'pay-payments';

export function createDeps(pool: PoolLike, config: ServiceConfig, overrides: { wallet?: WalletAuthorizer; now?: () => Date } = {}): Deps {
  const breaker = config.policy.circuit;
  const http = (name: string, upstream: { baseUrl: string; timeoutMs: number }) => new HttpClient({ name, baseUrl: upstream.baseUrl, serviceId: SERVICE_ID, timeoutMs: upstream.timeoutMs, retries: 1, breaker });
  return {
    pool,
    tx: txRunner(pool),
    config,
    clients: {
      risk: new RiskClient(http('pay-risk', config.upstream.risk)),
      connectors: new ConnectorsClient(http('pay-connectors', config.upstream.connectors)),
      ledger: new LedgerClient(http('pay-ledger', config.upstream.ledger)),
      // La bóveda se alcanza por su propia URL (VAULT_URL); sin ella no se verifica la tarjeta y el medio queda sin validar.
      vault: new VaultClient(http('pay-vault', { baseUrl: process.env.VAULT_URL ?? 'http://127.0.0.1:1', timeoutMs: 2000 })),
    },
    wallet: overrides.wallet ?? new DisabledWalletAuthorizer(),
    now: overrides.now ?? (() => new Date()),
  };
}
