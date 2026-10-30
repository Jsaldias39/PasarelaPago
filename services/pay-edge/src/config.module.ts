import { type DynamicModule, Global, Module } from '@nestjs/common';
import { SERVICE_CONFIG, type ServiceConfig } from './config';

/** Provee la configuración validada a todo el servicio. Dinámico para que las pruebas armen el borde con otra configuración. */
@Global()
@Module({})
export class ServiceConfigModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return { module: ServiceConfigModule, providers: [{ provide: SERVICE_CONFIG, useValue: config }], exports: [SERVICE_CONFIG] };
  }
}
