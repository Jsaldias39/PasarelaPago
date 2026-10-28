import { Controller, Get, Inject, Res } from '@nestjs/common';
import { PublicRoute } from '@pay/service-auth';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';

@PublicRoute()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde. Si no, `503` con el mismo formato (sin el mensaje del error: puede traer la cadena de conexión o SQL),
   * para que el orquestador saque la instancia de rotación en vez de ver un `500` sin sentido.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', info: { database: { status: 'up' } }, error: {}, details: { database: { status: 'up' } } };
    } catch {
      res.status(503);
      return { status: 'error', info: {}, error: { database: { status: 'down' } }, details: { database: { status: 'down' } } };
    }
  }
}
