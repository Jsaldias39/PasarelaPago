import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Identidad entre servicios (regla de separación #8: la red interna no es confiable).
 *
 * El certificado mTLS lo termina el proxy/malla de cada despliegue y lo mapea a `X-Service-Id`; este guard exige que
 * la cabecera exista, tenga forma de servicio de la pasarela y esté **en la lista de llamadores permitidos de esa ruta**.
 * Es seguro por defecto: una ruta sin `@AllowedServices(...)` ni `@PublicRoute()` responde 403.
 * Lanza `ForbiddenException` (403 por sí sola): no depende de que el filtro de errores del servicio esté instalado.
 *
 * LÍMITE CONOCIDO: acá no se puede probar que la cabecera coincida con el certificado (eso es del proxy y se prueba en
 * la ola 3 con mTLS real). Por eso el guard NO es una barrera suficiente por sí solo fuera de una red con mTLS.
 */

export const SERVICE_ID_HEADER = 'x-service-id';
const ALLOWED = Symbol('pay:allowed-services');
const PUBLIC = Symbol('pay:public-route');
const SERVICE_ID = /^pay-[a-z]+$/;

/** Servicios que pueden llamar a esta ruta (o a todas las de la clase). */
export const AllowedServices = (...services: string[]) => SetMetadata(ALLOWED, services);

/** Ruta sin identidad de servicio: salud y callbacks de proveedores (que se autentican por su firma). */
export const PublicRoute = () => SetMetadata(PUBLIC, true);

@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const allowed = this.reflector.getAllAndOverride<string[]>(ALLOWED, targets);
    // Sin lista no hay a quién dejar pasar: seguro por defecto.
    if (!allowed || allowed.length === 0) throw new ForbiddenException();

    const raw = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers[SERVICE_ID_HEADER];
    const caller = Array.isArray(raw) ? raw[0] : raw;
    if (!caller || !SERVICE_ID.test(caller) || !allowed.includes(caller)) throw new ForbiddenException();
    return true;
  }
}

/**
 * Cabeceras que un cliente HTTP interno manda a otro servicio.
 *
 * @param self - Nombre de quien llama (`pay-payments`).
 * @param extra - `traceparent`, `x-request-id`, `x-merchant-id`, `idempotency-key`…
 */
export function serviceHeaders(self: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
  if (!SERVICE_ID.test(self)) throw new RangeError(`Nombre de servicio inválido: ${self}`);
  const out: Record<string, string> = { [SERVICE_ID_HEADER]: self };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}
