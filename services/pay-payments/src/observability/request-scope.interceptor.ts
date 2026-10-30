import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithRequestId } from './trace-propagation';

/**
 * Deja el id de la petición (`req.id`, el `x-request-id` del cliente si venía bien formado) disponible para todo lo que corra mientras se atiende, incluidos los clientes
 * HTTP internos y el arranque del workflow: así el id viaja de extremo a extremo y no se reemplaza por un UUID en cada llamada (P1.H2.M3, T2). Corre DESPUÉS del
 * middleware de logs, que es quien asigna `req.id`.
 */
@Injectable()
export class RequestScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const requestId = context.switchToHttp().getRequest<{ id?: unknown }>().id;
    // La suscripción es lo que dispara el manejador: tiene que ocurrir DENTRO del alcance.
    return new Observable((subscriber) => {
      const subscription = runWithRequestId(requestId, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
