import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Configuración HTTP común a `main.ts` y a las pruebas: SIN prefijo de versión (pay-edge reenvía `/webhook_endpoints…` tal cual; el prefijo `/v1` es solo del borde público) y cierre ordenado.
 * Solo pay-edge llega a este servicio (identidad de servicio + red interna); el cuerpo es JSON chico (tope de Nest, 100 KB).
 */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.enableShutdownHooks();
}
