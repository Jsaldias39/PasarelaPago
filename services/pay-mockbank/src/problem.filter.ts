import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE, ProblemError, problem, type ProblemCode } from '@pay/problem';
import { BankProblem, BankProxyHtml, BankSocketCut } from './bank/faults';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { safeUrl } from './log-safe';

/**
 * Todo error sale como RFC 9457 con `code` estable y el `request_id` del cliente.
 * Los errores inesperados NO exponen mensaje, pila ni SQL: se registran con el id de correlación (regla 96.8).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id !== undefined ? String(request.id) : undefined;
    const instance = request.originalUrl === undefined ? undefined : safeUrl(request.originalUrl);
    const common = { ...(requestId !== undefined && { requestId }), ...(instance !== undefined && { instance }) };

    // Fallos que el banco simulado provoca a propósito (la orden SE EJECUTÓ pero la respuesta no sirve): ver `bank/faults.ts`.
    if (exception instanceof BankSocketCut) {
      const socket = response.socket;
      if (exception.how === 'reset') socket?.destroy();
      else setTimeout(() => socket?.destroy(), this.config.hangMs).unref(); // cuelga: el cliente vence por su timeout
      return;
    }
    if (exception instanceof BankProxyHtml) {
      response.status(502).type('text/html').send('<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>sandbox proxy</p></body></html>');
      return;
    }
    if (exception instanceof BankProblem) {
      // Cuerpo EXACTO del banco: es lo único que el conector toma como respuesta definitiva.
      response
        .status(exception.status)
        .type(PROBLEM_CONTENT_TYPE)
        .json({ type: `urn:sandbox:mockbank:problem:${exception.code}`, title: exception.code, status: exception.status, code: exception.code, ...(exception.detail && { detail: exception.detail }), ...(requestId !== undefined && { request_id: requestId }) });
      return;
    }

    let body;
    if (exception instanceof ProblemError) {
      body = { ...exception.toProblem(), ...(requestId !== undefined && { request_id: requestId }), ...(instance !== undefined && { instance }) };
    } else if (exception instanceof HttpException) {
      const code = this.codeFor(exception.getStatus());
      body = problem(code, common);
    } else {
      this.logger.error({ err: exception instanceof Error ? exception.name : 'desconocido', request_id: requestId }, 'Error no controlado');
      body = problem('internal_error', common);
    }
    response.status(body.status).type(PROBLEM_CONTENT_TYPE).json(body);
  }

  private codeFor(status: number): ProblemCode {
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'resource_not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 400 && status < 500) return 'validation_failed';
    return 'internal_error';
  }
}
