import 'reflect-metadata';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { InternalPaymentsController } from '../../src/payments/internal.controller';
import { PaymentsController } from '../../src/payments/payments.controller';
import { PaymentsService } from '../../src/payments/payments.service';
import { ProblemFilter } from '../../src/problem.filter';
import type { Stack } from './stack';

/** La app HTTP real (controladores + guard de identidad + filtro de errores) sobre el servicio y la base reales de `stack`. */
export async function httpApp(stack: Pick<Stack, 'service'>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PaymentsController, InternalPaymentsController],
    providers: [{ provide: PaymentsService, useValue: stack.service }, { provide: APP_GUARD, useClass: ServiceIdentityGuard }, { provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** `METHOD /ruta/{}` de cada handler con decoradores de ruta. */
export function routesOf(controller: { prototype: Record<string, unknown> }, base = ''): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined)
    .map((name) => {
      const handler = proto[name] as object;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const path = String(Reflect.getMetadata(PATH_METADATA, handler)).replace(/:[A-Za-z_]+/g, '{}');
      return `${method} ${`/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '')}`;
    })
    .sort();
}
export const normalizeOps = (ops: string[]): string[] => ops.map((op) => op.replace(/\{[^}]+\}/g, '{}')).sort();

export const EDGE = { 'x-service-id': 'pay-edge' } as const;
export const asMerchant = (merchantId: string) => ({ ...EDGE, 'x-merchant-id': merchantId });
