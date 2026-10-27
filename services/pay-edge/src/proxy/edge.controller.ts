import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EdgePipeline } from './edge.pipeline';

/** Toda la API pública entra por acá (bajo `/v1`); la tubería decide qué ruta es válida. */
@Controller()
export class EdgeController {
  constructor(private readonly pipeline: EdgePipeline) {}

  @All('*path')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.pipeline.handle(req, res);
  }
}
