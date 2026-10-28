import { type DynamicModule, Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import type { ServiceConfig } from './config';

/**
 * Pool de `pg` de pay-webhooks. No hay MikroORM acá: el servicio usa SQL directo (endpoints, secretos, entregas), igual que pay-edge, y se
 * comparte con las librerías @pay/* (idempotencia, inbox).
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
          useFactory: () => {
            const pool = new Pool({
              host: config.db.host,
              port: config.db.port,
              user: config.db.user,
              password: config.db.password,
              database: config.db.name,
              max: 10,
              application_name: 'pay-webhooks',
              // Esquema opcional (aislamiento en pruebas); validado en config.ts, nunca texto libre.
              ...(config.db.schema ? { options: `-c search_path=${config.db.schema}` } : {}),
            });
            // Si Postgres corta una conexión ociosa (reinicio, failover, pg_terminate_backend) el pool emite `error`; sin manejador Node lo trata como
            // excepción no capturada y el proceso muere. El pool descarta esa conexión y abre otra en la siguiente consulta. Solo el NOMBRE del error al
            // log: el mensaje de `pg` puede traer el host, el usuario o el texto de una consulta.
            pool.on('error', (error) => new Logger('PgPool').warn({ err: error.name }, 'Conexión ociosa cortada por Postgres; el pool la repone'));
            return pool;
          },
        },
      ],
      exports: [PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
