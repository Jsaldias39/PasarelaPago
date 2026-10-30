import { Module } from '@nestjs/common';
import { AssessmentsController } from './assessments/assessments.controller';
import { AssessmentsService } from './assessments/assessments.service';
import { DenyAllOperatorAuthenticator, OPERATOR_AUTHENTICATOR, OperatorGuard } from './operators/operator-auth';
import { RuleSetsController } from './rules/rule-sets.controller';
import { CLOCK, RuleSetsService } from './rules/rule-sets.service';
import { SANCTIONS_SCREENER } from './screening/screener';
import { WatchmanScreener } from './screening/watchman.screener';
import { RISK_SETTINGS, loadRiskSettings } from './settings';

/**
 * Cableado del dominio de riesgo. Los umbrales de sanciones y la clave de huella no tienen valor por defecto:
 * si faltan, `loadRiskSettings` lanza y el servicio no arranca (regla 90.3.4). El verificador de operadores trae por
 * defecto uno que niega a todos hasta que exista el servicio de identidad (PR-08).
 */
@Module({
  controllers: [AssessmentsController, RuleSetsController],
  providers: [
    { provide: RISK_SETTINGS, useFactory: () => loadRiskSettings() },
    { provide: CLOCK, useValue: () => new Date() },
    { provide: SANCTIONS_SCREENER, useClass: WatchmanScreener },
    { provide: OPERATOR_AUTHENTICATOR, useClass: DenyAllOperatorAuthenticator },
    OperatorGuard,
    RuleSetsService,
    AssessmentsService,
  ],
})
export class RiskModule {}
