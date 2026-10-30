import type { INestApplication } from '@nestjs/common';
import { json, raw } from 'express';

/** Opciones de creación: los parsers se registran a mano en `configureBodyParsers` para poder dejar CRUDO el cuerpo de los callbacks. */
export const APP_OPTIONS = { bodyParser: false } as const;

/**
 * Los callbacks se firman sobre los bytes EXACTOS que manda el proveedor: se reciben como `Buffer` (JSON, XML o lo que sea) y se
 * interpretan en el adaptador, después de verificar. El resto del servicio recibe JSON normal.
 */
export function configureBodyParsers(app: INestApplication): void {
  app.use('/callbacks', raw({ type: () => true, limit: '256kb' }));
  app.use(json({ limit: '256kb' }));
}
