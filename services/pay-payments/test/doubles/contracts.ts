import { join } from 'node:path';

/** Rutas a los contratos. Jest corre con el directorio del servicio como cwd. */
const OPENAPI = join(process.cwd(), '../../contracts/openapi');
export const CONTRACTS = {
  publicV1: join(OPENAPI, 'public-v1.yaml'),
  payments: join(OPENAPI, 'internal-payments-v1.yaml'),
  risk: join(OPENAPI, 'internal-risk-v1.yaml'),
  connectors: join(OPENAPI, 'internal-connectors-v1.yaml'),
  ledger: join(OPENAPI, 'internal-ledger-v1.yaml'),
  vault: join(OPENAPI, 'internal-vault-v1.yaml'),
};
export const ASYNCAPI_PAYMENTS = join(process.cwd(), '../../contracts/asyncapi/payments.yaml');
