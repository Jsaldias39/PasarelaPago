import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE } from '@pay/problem';

/** Aplica el resultado de `@pay/idempotency` a la respuesta: estado guardado, marca de repetición y tipo de contenido de error. */
export function send(res: Response, result: { status: number; body: unknown; replayed: boolean }): unknown {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  if (result.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
  return result.body;
}
