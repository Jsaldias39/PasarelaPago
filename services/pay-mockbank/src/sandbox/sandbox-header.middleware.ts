import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * D-26: en sandbox TODA respuesta lleva `X-Pay-Mode: sandbox` (contracts/openapi/common.yaml, `XPayModeSandbox`): también los 403, 404, errores y la salud.
 * Es middleware (no interceptor) para que el guard de identidad, que rechaza antes de llegar a los interceptores, también lo lleve.
 */
@Injectable()
export class SandboxHeaderMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Pay-Mode', 'sandbox');
    next();
  }
}
