import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { SERVICE_CONFIG, type ServiceConfig } from './config';

/**
 * D-26: en un despliegue `sandbox` TODA respuesta lleva `X-Pay-Mode: sandbox` (contracts/openapi/common.yaml, `XPayModeSandbox`): éxitos, errores,
 * 403 del guard de identidad, 404 de rutas inexistentes, salud y callbacks. En `live` la cabecera NO se envía.
 * Es un middleware (no un interceptor) para que también la lleven las respuestas que se cortan antes de llegar a los interceptores.
 * Va aparte de `X-Pay-Mode` de la PETICIÓN (`test|live`, el modo de la clave: D-28), que es otra cosa.
 */
@Injectable()
export class SandboxHeaderMiddleware implements NestMiddleware {
  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceConfig) {}

  use(_req: Request, res: Response, next: NextFunction): void {
    if (this.config.mode === 'sandbox') res.setHeader('X-Pay-Mode', 'sandbox');
    next();
  }
}
