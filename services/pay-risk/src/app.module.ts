import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { resolveRequestId } from '@pay/idempotency';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { loadConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { HealthController } from './health.controller';
import { ProblemFilter } from './problem.filter';
import { logSink } from './logging.sink';
import { safeUrl } from './log-safe';
import { RiskModule } from './risk.module';

const config = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.logLevel,
        stream: logSink,
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
    RiskModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Seguro por defecto: toda ruta sin @AllowedServices(...) ni @PublicRoute() responde 403.
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
  ],
})
export class AppModule {}
