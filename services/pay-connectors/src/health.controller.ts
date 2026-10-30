import { Controller, Get, Inject, Res } from '@nestjs/common';
import { PublicRoute } from '@pay/service-auth';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { AppendOnlyGuardsProbe } from './append-only-guards';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { PG_POOL } from './database.module';

@PublicRoute()
@Controller('health')
export class HealthController {
  private readonly guards: AppendOnlyGuardsProbe;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SERVICE_CONFIG) config: ServiceConfig,
  ) {
    this.guards = new AppendOnlyGuardsProbe(pool, config.mode);
  }

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde y los guardianes de solo-agregar de `connector_callback_events` y `connector_api_attempts` existen (`checks.append_only_guards`, REVISION-DINERO F-D1).
   * Bajo `PAY_MODE=live`, un guardián ausente ⇒ `503`; en sandbox sigue listo pero `ok: false` se ve y se avisa en el log.
   * Si la base no responde, `503` con el mismo formato (sin el mensaje del error: puede traer la cadena de conexión o SQL), para que el orquestador saque la instancia de rotación en vez de ver un `500` sin sentido.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      res.status(503);
      // Con la base caída no se puede verificar nada más: los guardianes salen como no verificados (fail-closed), sin acusarlos en el log.
      return { status: 'error', info: {}, error: { database: { status: 'down' } }, details: { database: { status: 'down' } }, checks: { append_only_guards: await this.guards.report() } };
    }
    const guards = await this.guards.report();
    const checks = { append_only_guards: guards };
    if (this.guards.blocksReadiness(guards)) {
      res.status(503);
      const down = { append_only_guards: { status: 'down', ...guards } };
      return { status: 'error', info: { database: { status: 'up' } }, error: down, details: { database: { status: 'up' }, ...down }, checks };
    }
    return { status: 'ok', info: { database: { status: 'up' } }, error: {}, details: { database: { status: 'up' } }, checks };
  }
}
