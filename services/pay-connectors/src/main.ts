// PRIMERA IMPORTACIÓN del proceso, y debe seguir siéndolo (instrumentación de OpenTelemetry).
import './observability/telemetry';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureBodyParsers } from './app.setup';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true, ...APP_OPTIONS });
  app.useLogger(app.get(Logger));
  configureBodyParsers(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
