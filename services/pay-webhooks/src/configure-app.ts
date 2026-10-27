import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Configuración HTTP común a `main.ts` y a las pruebas: prefijo `/v1` (la salud queda fuera) y cierre ordenado.
 * Solo pay-edge llega a este servicio (identidad de servicio + red interna); el cuerpo es JSON chico (tope de Nest, 100 KB).
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
}
