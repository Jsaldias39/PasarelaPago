import { type OnApplicationShutdown, type OnModuleInit, Inject, Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys/api-keys.service';
import { FeesService } from './fees/fees.service';
import { KycService } from './kyc/kyc.service';
import { FsObjectStore, OBJECT_STORE } from './kyc/object-store';
import { LegalService } from './legal/legal.service';
import { BackofficeController, ContractVersionsController } from './merchants/backoffice.controller';
import { MerchantsService } from './merchants/merchants.service';
import { PublicController } from './merchants/public.controller';
import { JwtOperatorAuthenticator } from './operators/jwt-operator-authenticator';
import { DenyAllOperatorAuthenticator, OPERATOR_AUTHENTICATOR, OperatorGuard } from './operators/operator-auth';
import { SETTINGS, loadSettings, type Settings } from './settings';

/**
 * Cableado del dominio de comercios. Los puntos de extensión (`OBJECT_STORE`, `OPERATOR_AUTHENTICATOR`) traen por defecto
 * una implementación que NO es de producción: un filesystem local (doble [DEV], que `live` no admite) y, sin credencial
 * configurada, un verificador que niega a todos. Con `OPERATOR_TOKEN_*` el verificador es JWT RS256 atado al modo.
 */
@Module({
  controllers: [PublicController, BackofficeController, ContractVersionsController],
  providers: [
    { provide: SETTINGS, useFactory: () => loadSettings() },
    { provide: OBJECT_STORE, inject: [SETTINGS], useFactory: (settings: Settings) => new FsObjectStore(settings.kycStoreDir) },
    {
      provide: OPERATOR_AUTHENTICATOR,
      inject: [SETTINGS],
      // Sin credencial configurada (solo sandbox) NADIE es operador: falla cerrado. Con ella, JWT RS256 atado al modo del despliegue.
      useFactory: (settings: Settings) =>
        settings.operator
          ? new JwtOperatorAuthenticator(settings.operator.publicKeyPem, settings.operator.issuer, settings.operator.audience, settings.payMode)
          : new DenyAllOperatorAuthenticator(),
    },
    OperatorGuard,
    MerchantsService,
    KycService,
    LegalService,
    FeesService,
    ApiKeysService,
  ],
  exports: [ApiKeysService, MerchantsService],
})
export class MerchantsModule implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly keys: ApiKeysService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  /** Barrido periódico de claves cuyo periodo de gracia terminó. */
  onModuleInit(): void {
    if (!this.settings.backgroundJobsEnabled) return;
    this.timer = setInterval(() => void this.keys.sweepRotated().catch(() => undefined), 30_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
