import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PublicRoute } from '@pay/service-auth';
import { CallbacksService } from '../core/callbacks.service';

/** Público hacia el proveedor: se autentica con la verificación propia de cada conector, no con identidad de servicio. */
@Controller('callbacks')
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}

  @Post(':connectorId')
  @HttpCode(200)
  @PublicRoute()
  async receive(@Param('connectorId') connectorId: string, @Req() req: Request): Promise<{ result: string; charge_id: string | null }> {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
    // La firma se calcula sobre los bytes EXACTOS: el cuerpo llega crudo (ver app.setup.ts).
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const outcome = await this.callbacks.receive({ connectorId, headers, rawBody, ...(req.socket.remoteAddress && { sourceIp: req.socket.remoteAddress }) });
    return { result: outcome.result, charge_id: outcome.chargeId };
  }
}
