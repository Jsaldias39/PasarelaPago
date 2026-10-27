import { startWebhooks, type WebhooksHarness } from './harness';
import { loadConfig } from '../src/config';

describe('pay-webhooks (arranque real contra su base)', () => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks();
  });
  afterAll(async () => h.stop());

  it('GET /health/live responde ok sin identidad de servicio y ', async () => {
    await h.http().get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready consulta la base propia e informa los streams sin tumbarse si no hay NATS', async () => {
    const response = await h.http().get('/health/ready').expect(200);
    expect(response.body.info.database.status).toBe('up');
    expect(response.body.info.events).toMatchObject({ status: 'up', subscribed_streams: 0, queued: 0 });
  });

  it('una ruta de negocio sin identidad de servicio es 403 (seguro por defecto)', async () => {
    await h.http().get('/webhook_endpoints').expect(403);
  });

  it('el `instance` de un error no repite segmentos de la URL que parezcan datos del cliente', async () => {
    const res = await h.http().get('/4111111111111111/ana@correo.com?x=1').expect(404);
    expect(res.body.instance).toBe('/:x/:x');
    expect(JSON.stringify(res.body)).not.toMatch(/4111|ana@|correo/);
  });

  it('un x-request-id mal formado se reemplaza por uno nuevo y no se anuncia el framework', async () => {
    const response = await h.http().get('/health/live').set('x-request-id', 'a b<script>').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('loadConfig — falla al arrancar con configuración inválida (regla 90.3.4)', () => {
  const base = { ...process.env };
  const without = (name: string) => {
    const env = { ...base };
    delete env[name];
    return env;
  };

  it('CORRECTO: el entorno de pruebas carga', () => {
    const config = loadConfig(base);
    expect(config.payMode).toBe('sandbox');
    expect(config.secretKek).toHaveLength(32);
    expect(config.delivery.scheduleMs).toEqual([0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000]);
  });

  it('los destinos de sandbox se leen en sandbox y NO se admiten con PAY_MODE=live (ni la CA)', () => {
    expect(loadConfig({ ...base, WEBHOOKS_SANDBOX_TARGETS: '127.0.0.1:41234, 127.0.0.1:41235' }).sandboxTargets).toEqual(['127.0.0.1:41234', '127.0.0.1:41235']);
    expect(loadConfig(base).sandboxTargets).toEqual([]);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_SANDBOX_TARGETS: '127.0.0.1:41234' })).toThrow(/PAY_MODE=live/);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_SANDBOX_CA_FILE: '/tmp/ca.pem' })).toThrow(/PAY_MODE=live/);
  });

  it.each(['PAY_MODE', 'WEBHOOKS_SECRET_KEK', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'])('falta %s ⇒ no arranca', (name) => {
    expect(() => loadConfig(without(name))).toThrow();
  });

  it.each([
    ['PAY_MODE', 'prod'],
    ['WEBHOOKS_SECRET_KEK', 'corta'],
    ['WEBHOOKS_SECRET_KEK', Buffer.alloc(31).toString('base64')],
    ['WEBHOOKS_RETRY_SCHEDULE_MS', '0,-5'],
    ['WEBHOOKS_RETRY_SCHEDULE_MS', 'a,b'],
    ['WEBHOOKS_EVENT_SOURCES', 'PAY_PAYMENTS'],
    ['WEBHOOKS_EVENT_SOURCES', 'A=b=c'],
    ['WEBHOOKS_RETRY_JITTER_PERCENT', '90'],
    ['DB_SCHEMA', 'x; DROP TABLE y'],
    ['PORT', '70000'],
    ['WEBHOOKS_SANDBOX_TARGETS', '10.0.0.5:8443'],
    ['WEBHOOKS_SANDBOX_TARGETS', '127.0.0.1'],
    ['WEBHOOKS_SANDBOX_TARGETS', 'localhost:8443'],
  ])('%s=%p inválido ⇒ no arranca', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow();
  });
});
