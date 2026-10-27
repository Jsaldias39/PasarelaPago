import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import type { ServiceConfig } from './config';

/**
 * Pool de `pg` de pay-edge. No hay MikroORM acá: el borde no tiene entidades propias, solo réplicas de solo lectura que se
 * consultan con SQL (a diferencia de la plantilla, que lo trae para los servicios con entidades).
 */
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: PG_POOL,
          useFactory: () =>
            new Pool({
              host: config.db.host,
              port: config.db.port,
              user: config.db.user,
              password: config.db.password,
              database: config.db.name,
              max: 10,
              application_name: 'pay-edge',
              // Esquema opcional (aislamiento en pruebas); validado en config.ts, nunca texto libre.
              ...(config.db.schema ? { options: `-c search_path=${config.db.schema}` } : {}),
            }),
        },
      ],
      exports: [PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
