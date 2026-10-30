import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { safeUrl } from './log-safe';
import { RawProblemError } from './raw-problem';
import { PROBLEM_CONTENT_TYPE, ProblemError, problem, type ProblemCode } from '@pay/problem';

/**
 * Todo error sale como RFC 9457 con `code` estable y el `request_id` del cliente.
 * Los errores inesperados NO exponen mensaje, pila ni SQL: se registran con el id de correlación (regla 96.8).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id !== undefined ? String(request.id) : undefined;
    const instance = request.originalUrl === undefined ? undefined : safeUrl(request.originalUrl);
    const common = { ...(requestId !== undefined && { requestId }), ...(instance !== undefined && { instance }) };

    let body;
    if (exception instanceof RawProblemError) {
      body = { ...exception.body, ...(requestId !== undefined && { request_id: requestId }), ...(instance !== undefined && { instance }) };
    } else if (exception instanceof ProblemError) {
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
