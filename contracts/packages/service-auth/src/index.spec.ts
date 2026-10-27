import { Controller, Get, type INestApplication, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { AllowedServices, PublicRoute, ServiceIdentityGuard, serviceHeaders } from './index';

@Controller('t')
@UseGuards(ServiceIdentityGuard)
class TestController {
  @Get('open')
  @PublicRoute()
  open() { return { ok: true }; }

  @Get('limited')
  @AllowedServices('pay-payments', 'pay-schedules')
  limited() { return { ok: true }; }

  @Get('forgotten') // sin decorador a propósito: debe quedar denegada
  forgotten() { return { ok: true }; }
}

@Module({ controllers: [TestController], providers: [ServiceIdentityGuard] })
class TestModule {}

describe('ServiceIdentityGuard', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  const server = () => app.getHttpServer();

  it('deja pasar a un llamador de la lista', async () => {
    await request(server()).get('/t/limited').set('x-service-id', 'pay-payments').expect(200, { ok: true });
    await request(server()).get('/t/limited').set('x-service-id', 'pay-schedules').expect(200);
  });

  it('niega a un servicio que no está en la lista, sin cabecera o con una cabecera mal formada', async () => {
    for (const id of ['pay-edge', 'pay-ledger']) await request(server()).get('/t/limited').set('x-service-id', id).expect(403);
    await request(server()).get('/t/limited').expect(403);
    for (const bad of ['', 'pay-', 'PAY-PAYMENTS', 'pay-payments;pay-edge', 'otro']) {
      await request(server()).get('/t/limited').set('x-service-id', bad).expect(403);
    }
  });

  it('es seguro por defecto: una ruta sin @AllowedServices responde 403 aunque el llamador sea legítimo', async () => {
    await request(server()).get('/t/forgotten').set('x-service-id', 'pay-payments').expect(403);
  });

  it('una ruta pública no pide identidad', async () => {
    await request(server()).get('/t/open').expect(200);
  });

  it('a nivel de guard, un valor con espacios sobrantes NO se acepta (HTTP los recorta antes, pero el guard no confía en eso)', () => {
    const guard = new ServiceIdentityGuard(new Reflector());
    const context = {
      getHandler: () => TestController.prototype.limited,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-service-id': 'pay-payments ' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('serviceHeaders arma las cabeceras y rechaza nombres inválidos', () => {
    expect(serviceHeaders('pay-payments', { traceparent: 't', 'Idempotency-Key': 'k', omitido: undefined })).toEqual({
      'x-service-id': 'pay-payments',
      traceparent: 't',
      'idempotency-key': 'k',
    });
    expect(() => serviceHeaders('payments')).toThrow(RangeError);
  });
});
