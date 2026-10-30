import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProblemError } from '@pay/problem';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config';
import { configureApp } from '../src/configure-app';
import type { NestExpressApplication } from '@nestjs/platform-express';

@Controller('probe')
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

describe('pay-edge (arranque real contra su base y su Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)], controllers: [ProbeController] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(nest, config);
    app = await nest.init();
  });
  afterAll(async () => app.close());

  it('GET /health/live responde ok, sin autenticación y fuera del prefijo /v1', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready consulta la base propia e informa el estado de la réplica sin tumbarse si no hay NATS', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body.info.database.status).toBe('up');
    expect(response.body.info.replica).toEqual({ status: 'up', subscribed: false });
  });

  it('un ProblemError sale como RFC 9457 con su request_id', async () => {
    const response = await request(app.getHttpServer()).get('/v1/probe/problem').set('x-request-id', 'req-abcdef-123').expect(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'insufficient_funds', status: 422, request_id: 'req-abcdef-123', instance: '/v1/probe/problem' });
    expect(response.headers['x-request-id']).toBe('req-abcdef-123');
  });

  it('un error inesperado NO expone el mensaje, la pila ni lo que contenía', async () => {
    const response = await request(app.getHttpServer()).get('/v1/probe/boom').expect(500);
    const text = JSON.stringify(response.body);
    expect(response.body.code).toBe('internal_error');
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('4111111111111111'); // el número completo: un trozo corto (4111) puede aparecer en un UUID aleatorio del request_id
    expect(text).not.toContain('stack');
  });

  it('una ruta desconocida sin credenciales es 401 (el borde no revela qué rutas existen a quien no se autenticó)', async () => {
    const response = await request(app.getHttpServer()).get('/v1/no-existe').expect(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('un x-request-id mal formado se reemplaza por uno nuevo', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').set('x-request-id', 'a b<script>').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('no anuncia el framework (X-Powered-By)', async () => {
    const response = await request(app.getHttpServer()).get('/health/live');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
