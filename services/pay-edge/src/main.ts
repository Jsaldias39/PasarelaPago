// PRIMERA IMPORTACIÓN del proceso, y debe seguir siéndolo (instrumentación de OpenTelemetry).
import './observability/telemetry';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
