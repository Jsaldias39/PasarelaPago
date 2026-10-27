import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ServiceConfig } from './config';

/**
 * Configuración HTTP común a `main.ts` y a las pruebas.
 * - Prefijo `/v1` (la salud queda fuera).
 * - SIN analizador de cuerpo: la tubería lee el cuerpo CRUDO solo después de autenticar y validar, con tope de tamaño (no se
 *   bufferea nada de quien todavía no se autenticó) y reenvía los bytes exactos que mandó el comercio.
 * - Solo se confía en `X-Forwarded-For` si hay saltos de proxy configurados (si no, cualquiera falsearía su IP).
 */
export function configureApp(app: NestExpressApplication, config: ServiceConfig): void {
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.enableShutdownHooks();
}
