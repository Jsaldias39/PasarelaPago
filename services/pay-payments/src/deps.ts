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
  const http = (name: string, upstream: { baseUrl: string; timeoutMs: number }, options: { ignoreTimeouts?: boolean } = {}) =>
    new HttpClient({ name, baseUrl: upstream.baseUrl, serviceId: SERVICE_ID, timeoutMs: upstream.timeoutMs, retries: 1, breaker: { ...breaker, ...options } });
  return {
    pool,
    tx: txRunner(pool),
    config,
    clients: {
      // La evaluación de riesgo es idempotente y sigue viva en pay-risk cuando el cliente vence: un timeout es ambiguo, no una falla (ver BreakerOptions.ignoreTimeouts).
      risk: new RiskClient(http('pay-risk', config.upstream.risk, { ignoreTimeouts: true })),
      connectors: new ConnectorsClient(http('pay-connectors', config.upstream.connectors)),
      ledger: new LedgerClient(http('pay-ledger', config.upstream.ledger)),
      // La bóveda se alcanza por `VAULT_URL`; ningún flujo la llama hoy (la tarjeta viaja como token), así que sin ella apunta a un puerto cerrado.
      vault: new VaultClient(http('pay-vault', { baseUrl: config.vaultUrl ?? 'http://127.0.0.1:1', timeoutMs: 2000 })),
    },
    wallet: overrides.wallet ?? new DisabledWalletAuthorizer(),
    now: overrides.now ?? (() => new Date()),
  };
}
