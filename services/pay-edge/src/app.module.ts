import { randomUUID } from 'node:crypto';
import { type DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import type { ServiceConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { EdgeModule } from './edge.module';
import { HealthController } from './health.controller';
import { safeUrl } from './log-safe';
import { ProblemFilter } from './problem.filter';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          // Comodín con nombre (path-to-regexp 8): el `*` por defecto de nestjs-pino, con el prefijo `/v1`, hace que Nest avise
          // «Unsupported route path: /v1/*» en cada arranque.
          forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
          pinoHttp: {
            level: config.logLevel,
            // Id de correlación: el del cliente si viene bien formado; si no, uno nuevo. Se devuelve en la respuesta.
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
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
        EdgeModule.forRoot(),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
