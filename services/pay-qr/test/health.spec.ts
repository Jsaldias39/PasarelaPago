import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProblemError } from '@pay/problem';
import { PublicRoute } from '@pay/service-auth';
import { AppModule } from '../src/app.module';

@Controller('probe')
@PublicRoute()
class ProbeController {
  @Get('problem')
  problem(): never {
    throw new ProblemError('insufficient_funds', { detail: 'Saldo menor al débito' });
  }

  @Get('boom')
  boom(): never {
    throw new Error('SELECT * FROM secreto WHERE tarjeta = 4111111111111111');
  }
}

describe('pay-qr (arranque real contra su base)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());

  it('GET /health/live responde ok', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready consulta la base propia', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body.info.database.status).toBe('up');
  });

  it('un ProblemError sale como RFC 9457 con su request_id', async () => {
    const response = await request(app.getHttpServer()).get('/probe/problem').set('x-request-id', 'req-abcdef-123').expect(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'insufficient_funds', status: 422, request_id: 'req-abcdef-123', instance: '/probe/problem' });
    expect(response.headers['x-request-id']).toBe('req-abcdef-123');
  });

  it('un error inesperado NO expone el mensaje, la pila ni lo que contenía', async () => {
    const response = await request(app.getHttpServer()).get('/probe/boom').expect(500);
    const text = JSON.stringify(response.body);
    expect(response.body.code).toBe('internal_error');
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('4111');
    expect(text).not.toContain('stack');
  });

  it('una ruta inexistente es 404 resource_not_found en RFC 9457', async () => {
    const response = await request(app.getHttpServer()).get('/no-existe').expect(404);
    expect(response.body.code).toBe('resource_not_found');
  });

  it('un x-request-id mal formado se reemplaza por uno nuevo', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').set('x-request-id', 'a b<script>').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
