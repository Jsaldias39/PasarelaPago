import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { guardPool } from './pool-guard';
import { SERVICE_CONFIG, type ServiceConfig } from './config';

/**
 * Pool de `pg` de la base PROPIA (`pay_mockbank`). Este servicio es un doble: no tiene entidades del modelo (D-18) ni ORM,
 * su esquema vive en `sql/001_mockbank.sql` y nadie más lo lee.
 */
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
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
          application_name: 'pay-mockbank',
        });
        return guardPool(pool, 'PgPool');
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
