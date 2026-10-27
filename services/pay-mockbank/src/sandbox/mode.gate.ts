import { ForbiddenException, Injectable } from '@nestjs/common';

/**
 * D-28: el modo de la CLAVE viaja en `X-Pay-Mode` (`test|live`). El banco simulado solo atiende `test` (su despliegue es `sandbox`):
 * ausente, repetido, inválido o `live` ⇒ 403 ANTES de cualquier efecto. Nunca se cae en otro modo.
 */
@Injectable()
export class ModeGate {
  require(raw: string | string[] | undefined): 'test' {
    if (raw === 'test') return 'test';
    throw new ForbiddenException();
  }
}
