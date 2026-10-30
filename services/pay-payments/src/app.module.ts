import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { loadConfig } from './config';
import { ServiceConfigModule } from './config.module';
import { DatabaseModule } from './database.module';
import { EventsModule } from './events.module';
import { HealthController } from './health.controller';
import { RequestScopeInterceptor } from './observability/request-scope.interceptor';
import { PaymentsModule } from './payments/payments.module';
import { ProblemFilter } from './problem.filter';
import { safeUrl } from './log-safe';
import { containsPan } from './domain/pan';

const config = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.logLevel,
        // Id de correlación: el del cliente si viene bien formado; si no, uno nuevo. Se devuelve en la respuesta.
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) && !containsPan(incoming) ? incoming : randomUUID();
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
    EventsModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Seguro por defecto: toda ruta exige un llamador permitido (@AllowedServices) o ser pública (@PublicRoute).
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
    // El id de la petición viaja a los clientes internos y al workflow (P1.H2.M3).
    { provide: APP_INTERCEPTOR, useClass: RequestScopeInterceptor },
  ],
})
export class AppModule {}
