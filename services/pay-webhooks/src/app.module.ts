import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import type { ServiceConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { HealthController } from './health.controller';
import { safeUrl } from './log-safe';
import { ProblemFilter } from './problem.filter';
import { WebhooksModule } from './webhooks.module';
import { resolveRequestId } from '@pay/idempotency';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.logLevel,
            // Id de correlación: el del cliente si viene bien formado y SIN forma de PAN (S-03); si no, uno nuevo. Se devuelve en la respuesta.
            genReqId: (req, res) => {
              const id = resolveRequestId(req.headers['x-request-id']);
              res.setHeader('x-request-id', id);
              return id;
            },
            // Nunca credenciales ni cuerpos en los logs (regla 90.2.1).
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.headers["idempotency-key"]'], remove: true },
            serializers: { req: (req) => ({ id: req.id, method: req.method, url: safeUrl(String(req.url)) }), res: (res) => ({ statusCode: res.statusCode }) },
            autoLogging: { ignore: (req) => String(req.url).startsWith('/health') },
          },
        }),
        TerminusModule,
        ServiceConfigModule.forRoot(config),
        DatabaseModule.forRoot(config),
        WebhooksModule.forRoot(),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
