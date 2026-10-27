import { ConnectorsClient } from '../../src/clients/connectors.client';
import { HttpClient } from '../../src/clients/http';
import { LedgerClient } from '../../src/clients/ledger.client';
import { RiskClient } from '../../src/clients/risk.client';
import { VaultClient } from '../../src/clients/vault.client';

const breaker = { failureThreshold: 50, resetAfterMs: 60_000 };
const make = (name: string, baseUrl: string, timeoutMs: number, retries = 0) => new HttpClient({ name, baseUrl, serviceId: 'pay-payments', timeoutMs, retries, breaker });

/** Clientes contra URLs de dobles, con reintentos apagados para que cada prueba controle cuántas llamadas hace. */
export const clientsFor = (urls: { risk?: string; connectors?: string; ledger?: string; vault?: string }, timeoutMs = 2000) => ({
  risk: new RiskClient(make('pay-risk', urls.risk ?? 'http://127.0.0.1:1', Math.min(timeoutMs, 300))),
  connectors: new ConnectorsClient(make('pay-connectors', urls.connectors ?? 'http://127.0.0.1:1', timeoutMs)),
  ledger: new LedgerClient(make('pay-ledger', urls.ledger ?? 'http://127.0.0.1:1', timeoutMs)),
  vault: new VaultClient(make('pay-vault', urls.vault ?? 'http://127.0.0.1:1', timeoutMs)),
});
