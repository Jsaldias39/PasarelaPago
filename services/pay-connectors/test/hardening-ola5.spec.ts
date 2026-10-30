import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { generateSecret, isUsableSecret, signedHeaders } from '@pay/webhook-signature';
import request from 'supertest';
import { loadConfig, isLoopbackHost, MAX_OPENBAO_CACHE_TTL_MS, MAX_OPENBAO_ROTATION_WINDOW_MS } from '../src/config';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import { SimulatedBank, type ScheduledCallback } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import type { Connector } from '../src/domain/connector';
import { ConnectorRegistry } from '../src/domain/registry';
import { EnvSecretProvider, namespaceOf, namespacesOverlap, ScopedSecretProvider } from '../src/domain/secrets';
import { chargeBody, createTestApp, post, type TestApp } from './support/app';

/**
 * Ola 5 · revisión de seguridad: S-08 (espacios de secretos), S-09 (topes de ventana), S-10 (config `live`) y S-18 (secreto mal formado ⇒ 401, nunca 500).
 * Tres niveles en cada uno: CORRECTO, LÍMITE e INVÁLIDO. Todo sintético; el OpenBao del tramo S-18 HTTP es un DOBLE declarado (un servidor KV v2 mínimo).
 */
const base = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' };
const SECRETS_LIVE = { SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://openbao.invalid:8200', OPENBAO_TOKEN: 'tok-sintetico-de-prueba' };
const live = { ...base, PAY_MODE: 'live', ...SECRETS_LIVE };
const sandboxBao = { ...base, PAY_MODE: 'sandbox', SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'http://127.0.0.1:8200', OPENBAO_TOKEN: 'tok-sintetico-de-prueba' };

describe('S-08 · el espacio de secretos de un conector no contiene el de otro', () => {
  const stub = (code: string, mode: 'sandbox' | 'live' = 'sandbox') => ({ code, mode }) as unknown as Connector;

  it('CORRECTO: los códigos reales del repo conviven (ninguno es prefijo delimitado de otro) y cada uno ve solo lo suyo', async () => {
    const registry = new ConnectorRegistry('sandbox');
    registry.register(stub('mock'));
    expect(() => new ConnectorRegistry('live').register(stub('mercantil_qr', 'live')).register(stub('mercantil_card', 'live')).register(stub('bank_transfer', 'live'))).not.toThrow();
    const all = new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MERCANTIL_QR_API_KEY: 'del-qr', PAY_SECRET_CONNECTOR_MERCANTIL_CARD_API_KEY: 'de-la-tarjeta' });
    expect(await new ScopedSecretProvider(all, namespaceOf('mercantil_qr')).getSecrets('CONNECTOR_MERCANTIL_QR_API_KEY')).toEqual(['del-qr']);
    expect(await new ScopedSecretProvider(all, namespaceOf('mercantil_qr')).getSecrets('CONNECTOR_MERCANTIL_CARD_API_KEY')).toEqual([]);
  });

  it('LÍMITE: «merc» NO es prefijo de «mercantil» (sin `_` no hay solapamiento); «mercantil» SÍ lo es de «mercantil_qr», en los dos órdenes de registro', () => {
    expect(namespacesOverlap('merc', 'mercantil')).toBe(false);
    expect(namespacesOverlap('mercantil', 'mercantil_qr')).toBe(true);
    expect(namespacesOverlap('mercantil_qr', 'mercantil')).toBe(true);
    expect(() => new ConnectorRegistry('sandbox').register(stub('merc')).register(stub('mercantil'))).not.toThrow();
    expect(() => new ConnectorRegistry('sandbox').register(stub('mercantil_qr')).register(stub('mercantil'))).toThrow(/comparte espacio de secretos/);
    expect(() => new ConnectorRegistry('sandbox').register(stub('mercantil')).register(stub('mercantil_qr'))).toThrow(/comparte espacio de secretos/);
  });

  it('INVÁLIDO: sin la guardia, el proveedor acotado de «mercantil» leería el secreto de «mercantil_qr» (el hallazgo); el registro lo impide y un código malformado no arma un prefijo', async () => {
    const all = new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MERCANTIL_QR_API_KEY: 'ajeno' });
    // Instrumento: el alcance del prefijo, tal cual está, SÍ fuga; por eso la guardia está en el registro (los dos conectores no pueden coexistir).
    expect(await new ScopedSecretProvider(all, namespaceOf('mercantil')).getSecrets('CONNECTOR_MERCANTIL_QR_API_KEY')).toEqual(['ajeno']);
    expect(() => new ConnectorRegistry('sandbox').register(stub('mercantil_qr')).register(stub('mercantil'))).toThrow();
    for (const bad of ['', 'Mock', 'mock_', '_mock', 'mer__qr', 'mock.x', 'mock/x', 'mock x', 'mock\n']) expect(() => namespaceOf(bad)).toThrow(/Código de conector inválido/);
  });
});

describe('S-09 · topes superiores de OPENBAO_CACHE_TTL_MS y OPENBAO_ROTATION_WINDOW_MS (en cualquier modo)', () => {
  it('CORRECTO: los valores por defecto y uno razonable arrancan', () => {
    const cfg = loadConfig(sandboxBao);
    expect(cfg.secrets).toMatchObject({ provider: 'openbao', cacheTtlMs: 5_000, rotationWindowMs: 86_400_000 });
    expect(loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: '60000', OPENBAO_ROTATION_WINDOW_MS: '172800000' }).secrets).toMatchObject({ cacheTtlMs: 60_000, rotationWindowMs: 172_800_000 });
  });

  it('LÍMITE: el tope exacto se acepta (5 min; 7 días) y 0 (sin caché / sin ventana) también; un milisegundo más no', () => {
    expect(MAX_OPENBAO_CACHE_TTL_MS).toBe(300_000);
    expect(MAX_OPENBAO_ROTATION_WINDOW_MS).toBe(604_800_000);
    expect(loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: '300000', OPENBAO_ROTATION_WINDOW_MS: '604800000' }).secrets).toMatchObject({ cacheTtlMs: 300_000, rotationWindowMs: 604_800_000 });
    expect(loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: '0', OPENBAO_ROTATION_WINDOW_MS: '0' }).secrets).toMatchObject({ cacheTtlMs: 0, rotationWindowMs: 0 });
    expect(() => loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: '300001' })).toThrow(/OPENBAO_CACHE_TTL_MS inválido: 300001 \(máximo 300000\)/);
    expect(() => loadConfig({ ...sandboxBao, OPENBAO_ROTATION_WINDOW_MS: '604800001' })).toThrow(/OPENBAO_ROTATION_WINDOW_MS inválido/);
    expect(() => loadConfig({ ...live, OPENBAO_ROTATION_WINDOW_MS: '604800001' })).toThrow(/OPENBAO_ROTATION_WINDOW_MS inválido/);
  });

  it('INVÁLIDO: un año de caché, diez años de ventana, negativos, decimales y texto no arrancan', () => {
    expect(() => loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: String(365 * 86_400_000) })).toThrow(/máximo/);
    expect(() => loadConfig({ ...sandboxBao, OPENBAO_ROTATION_WINDOW_MS: String(3650 * 86_400_000) })).toThrow(/máximo/);
    for (const value of ['-1', '1.5', 'diez', 'Infinity']) {
      expect(() => loadConfig({ ...sandboxBao, OPENBAO_CACHE_TTL_MS: value })).toThrow(/OPENBAO_CACHE_TTL_MS inválido/);
      expect(() => loadConfig({ ...sandboxBao, OPENBAO_ROTATION_WINDOW_MS: value })).toThrow(/OPENBAO_ROTATION_WINDOW_MS inválido/);
    }
  });
});

describe('S-10 · la config `live` rechaza OpenBao en loopback, un token dev-only-* y NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
  it('CORRECTO: live con OpenBao del despliegue (https, host real, token o AppRole de despliegue) arranca', () => {
    expect(() => loadConfig(live)).not.toThrow();
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://openbao.interno:8200', OPENBAO_ROLE_ID: 'r', OPENBAO_SECRET_ID: 's' })).not.toThrow();
    expect(() => loadConfig({ ...live, NODE_TLS_REJECT_UNAUTHORIZED: '1' })).not.toThrow();
    expect(() => loadConfig({ ...live, NODE_TLS_REJECT_UNAUTHORIZED: undefined })).not.toThrow();
  });

  it('LÍMITE: en sandbox nada de esto se exige (el arnés usa 127.0.0.1 y el token dev-only-root); un nombre que solo CONTIENE «localhost» no se confunde con un doble', () => {
    expect(() => loadConfig({ ...sandboxBao, OPENBAO_TOKEN: 'dev-only-root', NODE_TLS_REJECT_UNAUTHORIZED: '0' })).not.toThrow();
    expect(() => loadConfig({ ...live, OPENBAO_ADDR: 'https://localhost.pay.example.com:8200' })).not.toThrow();
    expect(() => loadConfig({ ...live, OPENBAO_ADDR: 'https://128.0.0.1:8200' })).not.toThrow();
    expect(() => loadConfig({ ...live, OPENBAO_TOKEN: 'dev-only' })).not.toThrow(); // sin el guion final no es el prefijo `dev-only-`
  });

  it.each(['https://localhost:8200', 'https://LOCALHOST.:8200', 'https://bao.localhost:8200', 'https://127.0.0.1:8200', 'https://127.1.2.3:8200', 'https://127.1:8200', 'https://2130706433:8200', 'https://0.0.0.0:8200', 'https://[::1]:8200', 'https://[::]:8200', 'https://[::ffff:127.0.0.1]:8200'])(
    'INVÁLIDO: OPENBAO_ADDR=%s bajo live ⇒ no arranca',
    (addr) => {
      expect(() => loadConfig({ ...live, OPENBAO_ADDR: addr })).toThrow(/loopback/);
    },
  );

  it('INVÁLIDO: token dev-only-* y NODE_TLS_REJECT_UNAUTHORIZED=0 bajo live ⇒ no arranca, y el mensaje no repite el token', () => {
    expect(() => loadConfig({ ...live, OPENBAO_TOKEN: 'dev-only-root' })).toThrow(/OPENBAO_TOKEN de desarrollo/);
    expect(() => loadConfig({ ...live, OPENBAO_TOKEN: 'dev-only-root' })).not.toThrow(/dev-only-root/);
    expect(() => loadConfig({ ...live, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0/);
  });

  it('isLoopbackHost: lo público no es loopback', () => {
    for (const host of ['openbao.interno', '10.0.0.5', '128.0.0.1', '8.8.8.8', '[2001:db8::1]', 'bao.example.com']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('S-18 · un secreto mal formado falla cerrado (ok:false), no lanza, y no anula al secreto bueno', () => {
  const NOW = new Date('2026-10-27T12:00:00Z');
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.status', reference: 'ch_aaaaaaaaaaaaaaaa', status: 'captured', occurred_at: NOW.toISOString(), amount_minor: 10000 });
  const GOOD = generateSecret();
  const BAD = ['whsec_corto', 'basura!!', `whsec_${'A'.repeat(200)}`, 'whsec_', ' '];
  const connectorWith = (value: string) => new MockConnector({ bank: new SimulatedBank(), qr: { issue: async () => ({ payload: '', expiresAt: NOW }) }, secrets: new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: value }) });
  const verifyWith = (value: string, signedWith: string[]) =>
    connectorWith(value).verifyCallback({ headers: signedHeaders({ id: 'evt_1', timestamp: Math.floor(NOW.getTime() / 1000), payload: body, secrets: signedWith }), rawBody: Buffer.from(body), now: NOW });

  it('CORRECTO: el secreto bueno verifica; un par de rotación [nuevo, anterior] acepta firmas con cualquiera de los dos', async () => {
    const OLD = generateSecret();
    expect((await verifyWith(GOOD, [GOOD])).ok).toBe(true);
    expect((await verifyWith(`${GOOD},${OLD}`, [OLD])).ok).toBe(true);
    expect(isUsableSecret(GOOD)).toBe(true);
  });

  it('LÍMITE: 24 y 64 bytes son utilizables; 23 y 65 no (los bordes de decodeSecret)', () => {
    expect(isUsableSecret(generateSecret(24))).toBe(true);
    expect(isUsableSecret(generateSecret(64))).toBe(true);
    expect(isUsableSecret(`whsec_${randomBytes(23).toString('base64')}`)).toBe(false);
    expect(isUsableSecret(`whsec_${randomBytes(65).toString('base64')}`)).toBe(false);
    for (const value of [undefined, null, 42, {}, '', ...BAD]) expect(isUsableSecret(value)).toBe(false);
  });

  it.each(BAD)('INVÁLIDO: el único secreto es «%s» ⇒ ok:false sin lanzar (antes: RangeError ⇒ 500)', async (bad) => {
    await expect(verifyWith(bad, [GOOD])).resolves.toEqual({ ok: false });
  });

  it.each(BAD)('INVÁLIDO: un par [«%s», bueno] NO anula al bueno: la firma legítima se acepta y una ajena no', async (bad) => {
    expect((await verifyWith(`${bad},${GOOD}`, [GOOD])).ok).toBe(true);
    expect((await verifyWith(`${bad},${GOOD}`, [generateSecret()])).ok).toBe(false);
  });
});

describe('S-18 · por HTTP: callback con el secreto mal formado en el almacén ⇒ 401 (no 500); con un par [malo, bueno] se acepta el legítimo', () => {
  const GOOD = generateSecret();
  let t: TestApp;
  let bao: Server;
  const served: Record<number, { value: string; created: string }> = {};

  beforeAll(async () => {
    // DOBLE de OpenBao: KV v2 mínimo (GET /v1/<mount>/data/<ruta>[?version=N]). La última versión es la mayor; la anterior se pide con ?version=N-1.
    bao = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const wanted = url.searchParams.get('version');
      const versions = Object.keys(served).map(Number);
      const version = wanted === null ? Math.max(...versions) : Number(wanted);
      const entry = served[version];
      res.setHeader('content-type', 'application/json');
      if (!entry || !url.pathname.endsWith('/CONNECTOR_MOCK_WEBHOOK_SECRET')) {
        res.statusCode = 404;
        res.end('{"errors":[]}');
        return;
      }
      res.end(JSON.stringify({ data: { data: { value: entry.value }, metadata: { version, created_time: entry.created, deletion_time: '', destroyed: false } } }));
    });
    await new Promise<void>((resolve) => bao.listen(0, '127.0.0.1', resolve));
    const port = (bao.address() as AddressInfo).port;
    t = await createTestApp({
      config: { secrets: { provider: 'openbao', addr: `http://127.0.0.1:${port}`, mount: 'secret', pathPrefix: 'pay-connectors', auth: { kind: 'token', token: 'tok-doble' }, cacheTtlMs: 0, rotationWindowMs: 3_600_000, timeoutMs: 1_500 } },
    });
  }, 60_000);
  afterAll(async () => {
    await t.close();
    await new Promise<void>((resolve) => bao.close(() => resolve()));
  });

  const setVersions = (...values: string[]) => {
    for (const key of Object.keys(served)) delete served[Number(key)];
    values.forEach((value, index) => (served[index + 1] = { value, created: new Date().toISOString() }));
  };
  const deliver = (headers: Record<string, string>, rawBody: Buffer) => request(t.app.getHttpServer()).post('/callbacks/mock').set(headers).set('content-type', 'application/json').send(rawBody.toString('utf8'));
  async function pendingCharge(): Promise<{ id: string; callback: ScheduledCallback; rawBody: Buffer }> {
    setVersions(GOOD); // mientras el almacén está sano, el conector arma el cuerpo del callback (lo firma el «banco»)
    const created = await post(t.app, '/charges', chargeBody({}, t.clock));
    expect(created.status).toBe(201);
    const callback = t.app.get<SimulatedBank>(SIMULATED_BANK).dueCallbacks(t.clock.now()).find((c) => c.reference === created.body.id) as ScheduledCallback;
    const mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
    return { id: created.body.id as string, callback, rawBody: (await mock.signCallback(callback, t.clock.now())).rawBody };
  }
  const signed = (callback: ScheduledCallback, rawBody: Buffer, secret: string) => signedHeaders({ id: callback.eventId, timestamp: Math.floor(t.clock.now().getTime() / 1000), payload: rawBody.toString('utf8'), secrets: [secret] });
  const statusOf = async (id: string) => (await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [id])).rows[0].provider_status as string;

  it('un secreto corto (24 bytes mínimos) en OpenBao ⇒ 401 unauthorized, el cobro no cambia', async () => {
    const c = await pendingCharge();
    setVersions('whsec_corto');
    const res = await deliver(signed(c.callback, c.rawBody, GOOD), c.rawBody);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(await statusOf(c.id)).toBe('pending');
  });

  it('un par [bueno (v1), malo (v2)] dentro de la ventana: el callback legítimo firmado con el bueno se APLICA (200) y uno firmado con otro secreto da 401', async () => {
    const c = await pendingCharge();
    setVersions(GOOD, `whsec_${'A'.repeat(200)}`);
    expect((await deliver(signed(c.callback, c.rawBody, generateSecret()), c.rawBody)).status).toBe(401);
    expect(await statusOf(c.id)).toBe('pending');
    const ok = await deliver(signed(c.callback, c.rawBody, GOOD), c.rawBody);
    expect(ok.status).toBe(200);
    expect(await statusOf(c.id)).toBe('captured');
  });
});
