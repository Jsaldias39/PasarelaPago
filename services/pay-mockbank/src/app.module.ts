import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { loadConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { HealthController } from './health.controller';
import { safeUrl } from './log-safe';
import { ProblemFilter } from './problem.filter';
import { SandboxHeaderMiddleware } from './sandbox/sandbox-header.middleware';
import { SandboxModule } from './sandbox/sandbox.module';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { resolveRequestId } from '@pay/idempotency';

const config = loadConfig();

@Module({
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
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], remove: true },
        serializers: { req: (req) => ({ id: req.id, method: req.method, url: safeUrl(String(req.url)) }), res: (res) => ({ statusCode: res.statusCode }) },
        autoLogging: { ignore: (req) => String(req.url).startsWith('/health') },
      },
    }),
    ServiceConfigModule,
    TerminusModule,
    DatabaseModule,
    SandboxModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Denegado por defecto: toda ruta sin @AllowedServices ni @PublicRoute responde 403.
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
  ],
})
export class AppModule implements NestModule {
  /** D-26: en sandbox toda respuesta (también la salud y los errores) lleva `X-Pay-Mode: sandbox`. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SandboxHeaderMiddleware).forRoutes('*');
  }
}
