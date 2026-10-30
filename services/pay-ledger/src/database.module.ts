import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { defineConfig } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { SERVICE_CONFIG, loadConfig, type ServiceConfig } from './config';
import { guardPool } from '@pay/idempotency';

/** Pool de `pg` que usan las librerías @pay/* (idempotencia, outbox, inbox). El ORM tiene el suyo. */
export const PG_POOL = Symbol('PG_POOL');

const config = loadConfig();

@Global()
@Module({
  imports: [
    // Mismo patrón que mantra-core-health-api: `forRoot` con la configuración ya resuelta, no `forRootAsync`.
    MikroOrmModule.forRoot(
      defineConfig({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        dbName: config.db.name,
        // Las entidades salen del modelo (D-18); este servicio todavía no declara ninguna.
        entities: ['dist/**/entities/*.entity.js'],
        entitiesTs: ['src/**/entities/*.entity.ts'],
        discovery: { warnWhenNoEntities: false },
        pool: { min: 1, max: 10 },
        forceUtcTimezone: true,
        driverOptions: { application_name: 'pay-ledger' },
      }),
    ),
  ],
  providers: [
    {
      provide: PG_POOL,
      inject: [SERVICE_CONFIG],
      useFactory: (config: ServiceConfig) => {
        const pool = new Pool({
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.name,
          max: 10,
          application_name: 'pay-ledger',
        });
        // Sin manejadores de `error` un corte de Postgres (reinicio, failover, pg_terminate_backend) tira el proceso, con la conexión ociosa Y con la prestada.
        const logger = new Logger('PgPool');
        return guardPool(pool, ({ err }) => logger.warn({ err }, 'Conexión ociosa cortada por Postgres; el pool la repone'));
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
