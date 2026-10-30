import { Global, Module } from '@nestjs/common';
import { SERVICE_CONFIG, loadConfig } from './config';

/** Provee la configuración validada a todo el servicio. Falla al construirse si falta una variable obligatoria. */
@Global()
@Module({
  providers: [{ provide: SERVICE_CONFIG, useFactory: () => loadConfig() }],
  exports: [SERVICE_CONFIG],
})
export class ServiceConfigModule {}
