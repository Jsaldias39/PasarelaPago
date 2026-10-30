import { Logger } from '@nestjs/common';
import type { ServiceConfig } from './config';
import { OpenBaoSecretProvider } from './domain/openbao-secrets';
import { EnvSecretProvider, type SecretProvider } from './domain/secrets';

/**
 * Arma el `SecretProvider` que dice `SECRET_PROVIDER` (la config ya validó que `live` sea `openbao`). El diagnóstico de OpenBao solo trae tipo,
 * nombre del secreto y estado HTTP: el evento no tiene dónde llevar un valor.
 */
export function createSecretProvider(config: ServiceConfig): SecretProvider {
  const { secrets } = config;
  if (secrets.provider === 'env') return new EnvSecretProvider();
  const logger = new Logger('OpenBaoSecrets');
  return new OpenBaoSecretProvider({
    addr: secrets.addr,
    mode: config.mode,
    mount: secrets.mount,
    pathPrefix: secrets.pathPrefix,
    auth: secrets.auth,
    cacheTtlMs: secrets.cacheTtlMs,
    rotationWindowMs: secrets.rotationWindowMs,
    timeoutMs: secrets.timeoutMs,
    onEvent: (event) => logger.warn({ event: event.kind, secret: event.name, status: event.status }, 'OpenBao no entregó el secreto (se rechaza)'),
  });
}
