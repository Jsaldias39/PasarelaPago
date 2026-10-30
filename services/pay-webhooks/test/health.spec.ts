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
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_SANDBOX_TARGETS: '127.0.0.1:41234' })).toThrow(/abren la entrega a la red local/);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_SANDBOX_CA_FILE: '/tmp/ca.pem' })).toThrow(/abren la entrega a la red local/);
  });

  it('D-26: la escalera de reintentos acortada es de sandbox y NO se admite con PAY_MODE=live', () => {
    expect(loadConfig({ ...base, WEBHOOKS_RETRY_SCHEDULE_MS: '0,200,400' }).delivery.scheduleMs).toEqual([0, 200, 400]);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_RETRY_SCHEDULE_MS: '0,200,400' })).toThrow(/acelerador de sandbox/);
  });

  describe('WEBHOOKS_ENGINE (D-26): svix (el servidor real) o inprocess (el doble)', () => {
    it('sandbox: sin valor o con inprocess arranca con el doble', () => {
      expect(loadConfig(base).engine).toBe('inprocess');
      expect(loadConfig({ ...base, WEBHOOKS_ENGINE: 'inprocess' }).engine).toBe('inprocess');
    });

    it('live SIN WEBHOOKS_ENGINE ⇒ no arranca y pide declararlo (no hay valor por defecto en live)', () => {
      expect(() => loadConfig({ ...base, PAY_MODE: 'live' })).toThrow(/exige declarar WEBHOOKS_ENGINE/);
    });

    it('live con inprocess ⇒ no arranca: es el doble de Svix y pide svix', () => {
      expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_ENGINE: 'inprocess' })).toThrow(/PAY_MODE=live no admite WEBHOOKS_ENGINE=inprocess.*doble de Svix.*svix/);
    });

    // Un JWT de FORMA válida y sintético (no firma nada): solo prueba la validación de forma.
    const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmdfcHJ1ZWJhIn0.c2lnbmF0dXJhLWRlLXBydWViYQ';
    const svixEnv = { ...base, WEBHOOKS_ENGINE: 'svix', WEBHOOKS_SVIX_URL: 'http://127.0.0.1:54800', WEBHOOKS_SVIX_AUTH_TOKEN: TOKEN };
    const liveSvix = { ...svixEnv, PAY_MODE: 'live', WEBHOOKS_SVIX_URL: 'https://svix.interno.example', WEBHOOKS_SVIX_NAMESPACE: 'prod-bo' };

    it('CORRECTO: sandbox con svix carga la configuración del servidor con sus valores por defecto', () => {
      const config = loadConfig(svixEnv);
      expect(config.engine).toBe('svix');
      expect(config.svix).toEqual({ url: 'http://127.0.0.1:54800', authToken: TOKEN, timeoutMs: 5_000, maxAttempts: 4, reconcileIntervalMs: 15_000, orphanGraceMs: 10 * 60_000, clockMarginMs: 60_000, namespace: 'sandbox', maxOrphanDeletesPerPass: 5, orphanAction: 'disable' });
      expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_URL: 'http://127.0.0.1:54800/' }).svix?.url).toBe('http://127.0.0.1:54800');
    });

    it('CORRECTO: live con svix sobre https arranca; inprocess ignora las variables de Svix', () => {
      expect(loadConfig(liveSvix)).toMatchObject({ engine: 'svix', payMode: 'live', svix: { url: 'https://svix.interno.example', namespace: 'prod-bo' } });
      expect(loadConfig({ ...svixEnv, WEBHOOKS_ENGINE: 'inprocess' }).svix).toBeUndefined();
    });

    it.each(['WEBHOOKS_SVIX_URL', 'WEBHOOKS_SVIX_AUTH_TOKEN'])('INVÁLIDO: con svix, sin %s ⇒ no arranca (el token no tiene valor por defecto)', (name) => {
      const env: Record<string, string | undefined> = { ...svixEnv };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(`Falta la variable de entorno ${name}`));
      expect(() => loadConfig({ ...env, [name]: '' })).toThrow(new RegExp(`Falta la variable de entorno ${name}`));
    });

    it.each(['no es una url', 'ftp://svix.example', 'https://usuario:clave@svix.example', 'https://svix.example/api/v1', 'https://svix.example/?a=1', 'https://svix.example/#x'])('INVÁLIDO: WEBHOOKS_SVIX_URL %j ⇒ no arranca', (url) => {
      expect(() => loadConfig({ ...svixEnv, WEBHOOKS_SVIX_URL: url })).toThrow(/WEBHOOKS_SVIX_URL inválido/);
    });

    it('INVÁLIDO: live exige https hacia Svix (el token y las claves de firma viajan por ahí); sandbox admite http', () => {
      expect(() => loadConfig({ ...liveSvix, WEBHOOKS_SVIX_URL: 'http://svix.interno.example:8071' })).toThrow(/https con PAY_MODE=live/);
      expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_URL: 'http://svix:8071' }).svix?.url).toBe('http://svix:8071');
    });

    it.each(['no-es-un-jwt', 'a.b', 'a.b.c.d', 'a b.c.d', 'a..c'])('INVÁLIDO: token %j ⇒ no arranca y el mensaje NO repite el token', (token) => {
      let message = '';
      try {
        loadConfig({ ...svixEnv, WEBHOOKS_SVIX_AUTH_TOKEN: token });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/WEBHOOKS_SVIX_AUTH_TOKEN inválido/);
      expect(message).not.toContain(token);
    });

    it('LÍMITE: Svix admite hasta 7 días de gracia en la rotación; 168 h pasa, 169 h no; el motor en proceso admite hasta 30 días', () => {
      expect(loadConfig({ ...svixEnv, WEBHOOKS_ROTATION_GRACE_HOURS: '168' }).rotationGraceMs).toBe(168 * 3_600_000);
      expect(loadConfig({ ...svixEnv, WEBHOOKS_ROTATION_GRACE_HOURS: '0' }).rotationGraceMs).toBe(0);
      expect(() => loadConfig({ ...svixEnv, WEBHOOKS_ROTATION_GRACE_HOURS: '169' })).toThrow(/no puede superar 168/);
      expect(loadConfig({ ...base, WEBHOOKS_ROTATION_GRACE_HOURS: '720' }).rotationGraceMs).toBe(720 * 3_600_000);
    });

    it.each([['WEBHOOKS_SVIX_TIMEOUT_MS', '50'], ['WEBHOOKS_SVIX_TIMEOUT_MS', '40000'], ['WEBHOOKS_SVIX_MAX_ATTEMPTS', '0'], ['WEBHOOKS_SVIX_MAX_ATTEMPTS', '11'], ['WEBHOOKS_SVIX_RECONCILE_INTERVAL_MS', '10'], ['WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES', '0']])('INVÁLIDO: %s=%s ⇒ no arranca', (name, value) => {
      expect(() => loadConfig({ ...svixEnv, [name]: value })).toThrow(new RegExp(`${name} inválido`));
    });

    describe('REVISION-DINERO F2/F5: espacio de nombres, tope de borrados, margen de reloj y gracia mínima', () => {
      it('CORRECTO: sandbox sin declararlo usa «sandbox»; declarado, usa el suyo; los valores opcionales se leen', () => {
        expect(loadConfig(svixEnv).svix?.namespace).toBe('sandbox');
        expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_NAMESPACE: 'staging-2' }).svix?.namespace).toBe('staging-2');
        expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_MAX_ORPHAN_DELETES: '0', WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS: '0' }).svix).toMatchObject({ maxOrphanDeletesPerPass: 0, clockMarginMs: 0 });
        expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_MAX_ORPHAN_DELETES: '1000', WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS: '3600' }).svix).toMatchObject({ maxOrphanDeletesPerPass: 1000, clockMarginMs: 3_600_000 });
      });

      it('INVÁLIDO: live SIN WEBHOOKS_SVIX_NAMESPACE ⇒ no arranca (no hay valor por defecto en live)', () => {
        const withoutNamespace: Record<string, string | undefined> = { ...liveSvix };
        delete withoutNamespace.WEBHOOKS_SVIX_NAMESPACE;
        expect(() => loadConfig(withoutNamespace)).toThrow(/exige declarar WEBHOOKS_SVIX_NAMESPACE/);
        expect(() => loadConfig({ ...withoutNamespace, WEBHOOKS_SVIX_NAMESPACE: '' })).toThrow(/exige declarar WEBHOOKS_SVIX_NAMESPACE/);
      });

      it('INVÁLIDO: live con el espacio de nombres del sandbox ⇒ no arranca (deben ser distintos)', () => {
        expect(() => loadConfig({ ...liveSvix, WEBHOOKS_SVIX_NAMESPACE: 'sandbox' })).toThrow(/no puede ser "sandbox" con PAY_MODE=live/);
      });

      it.each(['Prod', 'a', 'con espacio', '-empieza-con-guion', 'a'.repeat(33), 'tilde-é', 'a.b'])('INVÁLIDO: WEBHOOKS_SVIX_NAMESPACE %j ⇒ no arranca', (value) => {
        expect(() => loadConfig({ ...svixEnv, WEBHOOKS_SVIX_NAMESPACE: value })).toThrow(/WEBHOOKS_SVIX_NAMESPACE inválido/);
      });

      it('LÍMITE: con inprocess las variables de Svix (incluido el espacio de nombres) se ignoran', () => {
        expect(loadConfig({ ...base, WEBHOOKS_SVIX_NAMESPACE: 'Mal Formado' }).svix).toBeUndefined();
      });

      it.each([['WEBHOOKS_SVIX_MAX_ORPHAN_DELETES', '-1'], ['WEBHOOKS_SVIX_MAX_ORPHAN_DELETES', '1001'], ['WEBHOOKS_SVIX_MAX_ORPHAN_DELETES', '1.5'], ['WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS', '-1'], ['WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS', '3601']])('INVÁLIDO: %s=%s ⇒ no arranca', (name, value) => {
        expect(() => loadConfig({ ...svixEnv, [name]: value })).toThrow(new RegExp(`${name} inválido`));
      });

      describe('RE-REVISION-DINERO F-B1: WEBHOOKS_SVIX_ORPHAN_ACTION (deshabilitar por defecto; borrar solo a propósito)', () => {
        it('CORRECTO: sin declararlo, y declarando «disable», se deshabilita (también en live); «delete» en sandbox se admite', () => {
          expect(loadConfig(svixEnv).svix?.orphanAction).toBe('disable');
          expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_ORPHAN_ACTION: 'disable' }).svix?.orphanAction).toBe('disable');
          expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_ORPHAN_ACTION: '' }).svix?.orphanAction).toBe('disable');
          expect(loadConfig(liveSvix).svix?.orphanAction).toBe('disable');
          expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_ORPHAN_ACTION: 'delete' }).svix?.orphanAction).toBe('delete');
        });
        it('INVÁLIDO: en live, «delete» sin la confirmación deliberada (o con otro valor) ⇒ no arranca; con ella, arranca', () => {
          expect(() => loadConfig({ ...liveSvix, WEBHOOKS_SVIX_ORPHAN_ACTION: 'delete' })).toThrow(/exige declarar a propósito WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible/);
          expect(() => loadConfig({ ...liveSvix, WEBHOOKS_SVIX_ORPHAN_ACTION: 'delete', WEBHOOKS_SVIX_ORPHAN_DELETE_ACK: 'yes' })).toThrow(/WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible/);
          expect(() => loadConfig({ ...liveSvix, WEBHOOKS_SVIX_ORPHAN_ACTION: 'delete', WEBHOOKS_SVIX_ORPHAN_DELETE_ACK: 'IRREVERSIBLE' })).toThrow(/WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible/);
          expect(loadConfig({ ...liveSvix, WEBHOOKS_SVIX_ORPHAN_ACTION: 'delete', WEBHOOKS_SVIX_ORPHAN_DELETE_ACK: 'irreversible' }).svix?.orphanAction).toBe('delete');
        });
        it('LÍMITE: la confirmación sola, sin pedir «delete», no cambia nada (en live sigue deshabilitando)', () => {
          expect(loadConfig({ ...liveSvix, WEBHOOKS_SVIX_ORPHAN_DELETE_ACK: 'irreversible' }).svix?.orphanAction).toBe('disable');
        });
        it.each(['Delete', 'purge', 'remove', ' delete', 'true'])('INVÁLIDO: WEBHOOKS_SVIX_ORPHAN_ACTION=%j ⇒ no arranca', (value) => {
          expect(() => loadConfig({ ...svixEnv, WEBHOOKS_SVIX_ORPHAN_ACTION: value })).toThrow(/WEBHOOKS_SVIX_ORPHAN_ACTION inválido/);
        });
      });

      it('INVÁLIDO: una gracia de huérfanos menor que el peor caso de un alta ⇒ no arranca; los valores por defecto cubren el peor caso', () => {
        // defecto: 4 intentos × 5 s por llamada → ~9 min para 25 llamadas; la gracia por defecto es de 10
        expect(() => loadConfig({ ...svixEnv, WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES: '1' })).toThrow(/WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES.*peor caso de un alta/);
        expect(() => loadConfig({ ...svixEnv, WEBHOOKS_SVIX_TIMEOUT_MS: '30000', WEBHOOKS_SVIX_MAX_ATTEMPTS: '10' })).toThrow(/peor caso de un alta/);
        expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_TIMEOUT_MS: '30000', WEBHOOKS_SVIX_MAX_ATTEMPTS: '10', WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES: '135' }).svix?.orphanGraceMs).toBe(135 * 60_000);
        // límite: con un solo intento de 1 s el peor caso es de 25 s y 1 minuto alcanza (el mínimo de la variable)
        expect(loadConfig({ ...svixEnv, WEBHOOKS_SVIX_TIMEOUT_MS: '1000', WEBHOOKS_SVIX_MAX_ATTEMPTS: '1', WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES: '1' }).svix?.orphanGraceMs).toBe(60_000);
      });
    });

    it.each(['Svix', 'in-process', 'memory', ' inprocess', 'inprocess '])('valor inválido %j ⇒ no arranca en cualquier modo', (value) => {
      expect(() => loadConfig({ ...base, WEBHOOKS_ENGINE: value })).toThrow(/WEBHOOKS_ENGINE inválido/);
      expect(() => loadConfig({ ...base, PAY_MODE: 'live', WEBHOOKS_ENGINE: value })).toThrow(/WEBHOOKS_ENGINE inválido/);
    });
  });

  it.each(['', ' ', 'Live', 'SANDBOX', 'test', 'production'])('PAY_MODE=%j ⇒ no arranca (sin valor por defecto, sin tolerancia a variantes)', (value) => {
    expect(() => loadConfig({ ...base, PAY_MODE: value })).toThrow(/PAY_MODE/);
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
