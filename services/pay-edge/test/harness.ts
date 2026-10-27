import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { generateApiKey, type ApiKeyMode } from '@pay/api-key';
import { createIsolatedDatabase, loadContract, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, UPSTREAMS, type ServiceConfig, type UpstreamName } from '../src/config';
import { configureApp } from '../src/configure-app';
import { UpstreamDouble } from './doubles/upstream-double';

const SQL = join(process.cwd(), 'sql/001_edge.sql');
export const PUBLIC_CONTRACT = join(process.cwd(), '../../contracts/openapi/public-v1.yaml');

export interface EdgeHarness {
  readonly app: NestExpressApplication;
  readonly config: ServiceConfig;
  readonly db: IsolatedDatabase;
  readonly contract: ContractValidator;
  readonly doubles: Readonly<Record<UpstreamName, UpstreamDouble>>;
  /** Cliente HTTP contra el borde. */
  http(): ReturnType<typeof supertest>;
  /** Inserta una clave en la réplica y devuelve su token (que se mostraría una sola vez). */
  seedKey(options?: { mode?: ApiKeyMode; merchantId?: string; revokedAtSql?: string }): Promise<{ token: string; keyId: string; merchantId: string }>;
  setMerchantStatus(merchantId: string, status: 'active' | 'suspended' | 'closed'): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Variables de entorno que pisan los valores de prueba (por ejemplo `PAY_MODE=live` o límites chicos). */
  readonly env?: Record<string, string>;
  /** Cambia la base de las URLs de los destinos (por ejemplo, un puerto cerrado). */
  readonly upstreamUrls?: Partial<Record<UpstreamName, string>>;
  /**
   * Pone el borde en `live` DESPUÉS de cargar la configuración. `loadConfig` se niega a arrancar `live` con destinos en loopback
   * (D-26), y los dobles de estas pruebas son de loopback: acá lo que se prueba es la tubería en modo live, no la guardia
   * (la guardia tiene su propia prueba en config.spec.ts).
   */
  readonly liveAfterLoad?: boolean;
}

/** Levanta el borde COMPLETO con Postgres y Redis reales, un esquema propio, un prefijo de Redis propio y dobles de los destinos. */
export async function startEdge(options: StartOptions = {}): Promise<EdgeHarness> {
  const db = await createIsolatedDatabase([SQL]);
  const contract = await loadContract(PUBLIC_CONTRACT);
  const doubles = {} as Record<UpstreamName, UpstreamDouble>;
  const urls: Record<string, string> = {};
  for (const name of UPSTREAMS) {
    doubles[name] = new UpstreamDouble(contract);
    urls[`UPSTREAM_${name.toUpperCase().replace(/-/g, '_')}_URL`] = options.upstreamUrls?.[name] ?? (await doubles[name].start());
  }
  const loaded = loadConfig({
    ...process.env,
    ...urls,
    DB_SCHEMA: db.schema,
    RATE_LIMIT_PREFIX: `t:${randomBytes(4).toString('hex')}`,
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  const config: ServiceConfig = options.liveAfterLoad ? { ...loaded, payMode: 'live' } : loaded;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config);
  await app.init();

  return {
    app,
    config,
    db,
    contract,
    doubles,
    http: () => supertest(app.getHttpServer()),
    async seedKey(opts = {}) {
      const key = generateApiKey(opts.mode ?? 'test');
      const merchantId = opts.merchantId ?? `mc_${randomBytes(6).toString('hex')}`;
      await db.pool.query(
        `INSERT INTO api_key_replica (key_id, merchant_id, mode, key_hash, revoked_at, last_event_id)
         VALUES ($1, $2, $3, $4, ${opts.revokedAtSql ?? 'NULL'}, 'seed')`,
        [key.keyId, merchantId, key.mode, key.keyHash],
      );
      return { token: key.token, keyId: key.keyId, merchantId };
    },
    async setMerchantStatus(merchantId, status) {
      await db.pool.query(
        `INSERT INTO merchant_replica (merchant_id, status, status_at, last_event_id) VALUES ($1, $2, now(), 'seed')
         ON CONFLICT (merchant_id) DO UPDATE SET status = EXCLUDED.status`,
        [merchantId, status],
      );
    },
    async stop() {
      await app.close();
      await Promise.all(Object.values(doubles).map((d) => d.stop()));
      await db.drop();
    },
  };
}
