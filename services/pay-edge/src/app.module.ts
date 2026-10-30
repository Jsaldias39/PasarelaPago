import { type DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import type { DestinationStream } from 'pino';
import { LoggerModule } from 'nestjs-pino';
import type { ServiceConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { EdgeModule } from './edge.module';
import { HealthController } from './health.controller';
import { safeUrl } from './log-safe';
import { ProblemFilter } from './problem.filter';
import { resolveRequestId } from '@pay/idempotency';

type HttpLogOptions = Exclude<NonNullable<Parameters<typeof LoggerModule.forRoot>[0]>['pinoHttp'], DestinationStream | [unknown, unknown] | undefined>;
const withStream = (options: HttpLogOptions, stream?: DestinationStream) => (stream ? ([options, stream] as [HttpLogOptions, DestinationStream]) : options);

@Module({})
export class AppModule {
  /** `logStream` solo lo usan las pruebas, para leer exactamente lo que se registra (por defecto pino escribe a la salida estándar). */
  static forRoot(config: ServiceConfig, logStream?: DestinationStream): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          // Comodín con nombre (path-to-regexp 8): el `*` por defecto de nestjs-pino, con el prefijo `/v1`, hace que Nest avise
          // «Unsupported route path: /v1/*» en cada arranque.
          forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
          pinoHttp: withStream({
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
          }, logStream),
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
