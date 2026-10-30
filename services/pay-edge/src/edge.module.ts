import { type DynamicModule, Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { EdgeController } from './proxy/edge.controller';
import { EdgePipeline } from './proxy/edge.pipeline';
import { UpstreamClient } from './proxy/upstream.client';
import { RateLimiter } from './rate-limiter';
import { ReplicaConsumer } from './replica/replica.consumer';
import { ReplicaRepository } from './replica/replica.repository';

export const REDIS = Symbol('REDIS');

@Global()
@Module({})
export class EdgeModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  static forRoot(): DynamicModule {
    return {
      module: EdgeModule,
      controllers: [EdgeController],
      providers: [
        {
          provide: REDIS,
          inject: [SERVICE_CONFIG],
          useFactory: async (config: ServiceConfig) => {
            const logger = new Logger('Redis');
            // Sin cola offline y con tiempo corto: si Redis cae, el comando falla rápido y el limitador deja pasar (DT-1).
            const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 300, retryStrategy: (n) => Math.min(n * 200, 2_000) });
            redis.on('error', () => logger.warn('Redis no responde'));
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_000);
              redis.once('ready', () => {
                clearTimeout(timer);
                resolve();
              });
            });
            return redis;
          },
        },
        {
          provide: RateLimiter,
          inject: [REDIS, SERVICE_CONFIG],
          useFactory: (redis: Redis, config: ServiceConfig) => new RateLimiter(redis, config.rateLimit.prefix, config.rateLimit.windowSeconds),
        },
        {
          provide: UpstreamClient,
          inject: [SERVICE_CONFIG],
          useFactory: (config: ServiceConfig) =>
            new UpstreamClient({ urls: config.upstreams, timeoutMs: config.upstreamTimeoutMs, failureThreshold: config.breaker.failureThreshold, cooldownMs: config.breaker.cooldownMs }),
        },
        ReplicaRepository,
        ReplicaConsumer,
        EdgePipeline,
      ],
      exports: [ReplicaConsumer, UpstreamClient],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
