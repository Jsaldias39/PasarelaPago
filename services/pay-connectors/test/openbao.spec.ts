import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ConsoleLogger } from '@nestjs/common';
import request from 'supertest';
import { generateSecret, signedHeaders } from '@pay/webhook-signature';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { ScheduledCallback, SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import { OpenBaoSecretProvider, type OpenBaoEvent, type OpenBaoSecretOptions } from '../src/domain/openbao-secrets';
import type { ConnectorRegistry } from '../src/domain/registry';
import { namespaceOf, ScopedSecretProvider } from '../src/domain/secrets';
import { chargeBody, createTestApp, get, post, type TestApp } from './support/app';
import { TcpProxy } from './support/tcp-proxy';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { SQL } from './support/app';

// P4.H2.M6 — contra un OpenBao REAL (servidor `-dev` del Compose, KV v2). Cada corrida crea su propio montaje KV v2, una política y un token por conector
// (solo lectura de su espacio), y los borra al terminar. Todos los valores son SINTÉTICOS y aleatorios. El token raíz de desarrollo solo prepara y limpia el
// escenario: el código bajo prueba nunca lo recibe.
delete process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET; // el secreto del conector `mock` tiene que salir de OpenBao, no del entorno

const ADDR = process.env.PAY_TEST_OPENBAO_ADDR as string;
const ROOT = process.env.PAY_TEST_OPENBAO_ROOT_TOKEN as string;
const RUN = randomBytes(4).toString('hex');
const MOUNT = `pctest-${RUN}`;
const PREFIX = 'pay-connectors';
const POLICIES = { mock: `pctest-mock-${RUN}`, qr: `pctest-mqr-${RUN}`, proc: `pctest-proc-${RUN}` };
const ROLE = `pctest-role-${RUN}`;

const MOCK_NAME = 'CONNECTOR_MOCK_WEBHOOK_SECRET';

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- respuesta JSON de OpenBao en una prueba
}

/** Llamada a OpenBao con el token indicado (por defecto el raíz de desarrollo, solo para preparar y limpiar). */
async function bao(method: string, path: string, body?: unknown, token = ROOT): Promise<Reply> {
  const response = await fetch(`${ADDR}/v1/${path}`, { method, headers: { 'X-Vault-Token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

const kvPath = (name: string, mode = 'sandbox') => `${PREFIX}/${mode}/${name}`;
/** Escribe una versión nueva del secreto (KV v2) y devuelve su número de versión. */
async function put(name: string, value: string, mode = 'sandbox'): Promise<number> {
  const reply = await bao('POST', `${MOUNT}/data/${kvPath(name, mode)}`, { data: { value } });
  expect(reply.status).toBe(200);
  return reply.body.data.version as number;
}
const versions = async (verb: 'delete' | 'undelete' | 'destroy', name: string, list: number[], mode = 'sandbox') => {
  const reply = await bao('POST', `${MOUNT}/${verb}/${kvPath(name, mode)}`, { versions: list });
  expect(reply.status).toBe(204);
};

const policyFor = (code: string, mode = 'sandbox') => `path "${MOUNT}/data/${PREFIX}/${mode}/${namespaceOf(code)}*" { capabilities = ["read"] }`;
async function tokenFor(policy: string): Promise<string> {
  const reply = await bao('POST', 'auth/token/create', { policies: [policy], no_default_policy: true, ttl: '1h', no_parent: true, display_name: `pctest-${RUN}` });
  expect(reply.status).toBe(200);
  return reply.body.auth.client_token as string;
}

let mockToken = '';
let qrToken = '';
let roleId = '';
let secretId = '';
let approleEnabledByMe = false;
const issued: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${ADDR}/v1/sys/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`OpenBao de desarrollo no responde en ${ADDR}. Levantalo: HUB=mirror.gcr.io docker compose -f platform/compose.yml --profile full up -d openbao`);
  expect((await bao('POST', `sys/mounts/${MOUNT}`, { type: 'kv', options: { version: '2' } })).status).toBe(204);
  expect((await bao('POST', `sys/policies/acl/${POLICIES.mock}`, { policy: policyFor('mock') })).status).toBe(204);
  expect((await bao('POST', `sys/policies/acl/${POLICIES.qr}`, { policy: policyFor('mercantil_qr') })).status).toBe(204);
  mockToken = await tokenFor(POLICIES.mock);
  qrToken = await tokenFor(POLICIES.qr);
  issued.push(mockToken, qrToken);
  // AppRole (ruta estándar `approle`): se habilita solo si no estaba y se deshabilita al terminar.
  const auths = await bao('GET', 'sys/auth');
  if (!('approle/' in auths.body.data)) {
    expect((await bao('POST', 'sys/auth/approle', { type: 'approle' })).status).toBe(204);
    approleEnabledByMe = true;
  }
  expect((await bao('POST', `auth/approle/role/${ROLE}`, { token_policies: [POLICIES.mock], token_ttl: '1h', secret_id_ttl: '1h', token_no_default_policy: true })).status).toBe(204);
  roleId = (await bao('GET', `auth/approle/role/${ROLE}/role-id`)).body.data.role_id as string;
  secretId = (await bao('POST', `auth/approle/role/${ROLE}/secret-id`)).body.data.secret_id as string;
}, 60_000);

afterAll(async () => {
  for (const token of issued) await bao('POST', 'auth/token/revoke', { token });
  await bao('DELETE', `auth/approle/role/${ROLE}`);
  if (approleEnabledByMe) await bao('DELETE', 'sys/auth/approle');
  for (const policy of Object.values(POLICIES)) await bao('DELETE', `sys/policies/acl/${policy}`);
  await bao('DELETE', `sys/mounts/${MOUNT}`);
});

function provider(token: string, over: Partial<OpenBaoSecretOptions> = {}, events: OpenBaoEvent[] = []): OpenBaoSecretProvider {
  return new OpenBaoSecretProvider({ addr: ADDR, mode: 'sandbox', mount: MOUNT, pathPrefix: PREFIX, auth: { kind: 'token', token }, cacheTtlMs: 0, rotationWindowMs: 60_000, timeoutMs: 2_000, onEvent: (event) => events.push(event), ...over });
}
/** `fetch` que cuenta las llamadas que de verdad salen hacia OpenBao. */
function counting(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return { urls, fetch: (async (input: string | URL | Request, init?: RequestInit) => (urls.push(String(input)), fetch(input, init))) as typeof fetch };
}
const fresh = (() => {
  let n = 0;
  return (code = 'MOCK') => `CONNECTOR_${code}_K${(n += 1)}_${RUN.toUpperCase()}`;
})();

describe('P4.H2.M6 contra OpenBao real — correcto', () => {
  it('lee el secreto de su espacio (KV v2) con un token de solo lectura', async () => {
    const name = fresh();
    expect(await put(name, 'valor-sintetico-1')).toBe(1);
    const events: OpenBaoEvent[] = [];
    expect(await provider(mockToken, {}, events).getSecrets(name)).toEqual(['valor-sintetico-1']);
    expect(events).toEqual([]);
  });

  it('rotar con versiones KV v2: la nueva se usa sin reiniciar y la anterior sigue válida dentro de la ventana', async () => {
    const name = fresh();
    const v1 = `v1-${generateSecret()}`;
    const v2 = `v2-${generateSecret()}`;
    const v3 = `v3-${generateSecret()}`;
    expect(await put(name, v1)).toBe(1);
    const cached = provider(mockToken, { cacheTtlMs: 300 });
    expect(await cached.getSecrets(name)).toEqual([v1]);
    expect(await put(name, v2)).toBe(2); // rotación: versión 2 en KV v2
    expect(await cached.getSecrets(name)).toEqual([v1]); // dentro del TTL, el caché breve
    // Vencido el TTL (esperando la condición, no un tiempo fijo) el mismo objeto, sin reiniciar, ve la versión nueva Y la anterior.
    expect(await until(async () => ((await cached.getSecrets(name)).length === 2 ? await cached.getSecrets(name) : undefined), 5_000)).toEqual([v2, v1]);
    // Re-lectura inmediata al rotar: invalidate() no espera al TTL.
    expect(await put(name, v3)).toBe(3);
    cached.invalidate(name);
    expect(await cached.getSecrets(name)).toEqual([v3, v2]);
  });

  it('la ventana de rotación vence sola (created_time del servidor real); la versión anterior deja de valer', async () => {
    const name = fresh();
    const v1 = generateSecret();
    const v2 = generateSecret();
    await put(name, v1);
    await put(name, v2);
    const short = provider(mockToken, { rotationWindowMs: 1_500 });
    expect(await short.getSecrets(name)).toEqual([v2, v1]); // recién rotada: las dos vigentes
    expect(await until(async () => ((await short.getSecrets(name)).length === 1 ? await short.getSecrets(name) : undefined), 10_000)).toEqual([v2]);
  });

  it('cerrar la ventana a mano: borrar la versión anterior deja vigente solo la nueva', async () => {
    const name = fresh();
    const v1 = generateSecret();
    const v2 = generateSecret();
    await put(name, v1);
    await put(name, v2);
    const p = provider(mockToken);
    expect(await p.getSecrets(name)).toEqual([v2, v1]);
    await versions('delete', name, [1]);
    expect(await p.getSecrets(name)).toEqual([v2]);
    await versions('destroy', name, [1]);
    expect(await p.getSecrets(name)).toEqual([v2]);
  });

  it('AppRole real: se autentica con role_id + secret_id, lee con el token emitido y no con el raíz', async () => {
    const name = fresh();
    const value = generateSecret();
    await put(name, value);
    const calls = counting();
    const p = provider('', { auth: { kind: 'approle', roleId, secretId }, fetch: calls.fetch });
    expect(await p.getSecrets(name)).toEqual([value]);
    expect(await p.getSecrets(name)).toEqual([value]);
    expect(calls.urls.filter((u) => u.endsWith('/v1/auth/approle/login'))).toHaveLength(1); // un solo login: reutiliza el token
  });
});

describe('P4.H2.M6 contra OpenBao real — límite', () => {
  it('secreto ausente ⇒ [] (fail-closed), nunca un valor por defecto', async () => {
    const events: OpenBaoEvent[] = [];
    expect(await provider(mockToken, {}, events).getSecrets(fresh())).toEqual([]);
    expect(events.map((e) => [e.kind, e.status])).toEqual([['missing', 404]]);
  });

  it('versión borrada o destruida: la última ⇒ [] y no se cae a una anterior; undelete la restaura; una escritura nueva la reemplaza', async () => {
    const name = fresh();
    const [a, b, c] = [generateSecret(), generateSecret(), generateSecret()] as [string, string, string];
    await put(name, a);
    await put(name, b);
    const events: OpenBaoEvent[] = [];
    const p = provider(mockToken, {}, events);
    await versions('delete', name, [2]);
    expect(await p.getSecrets(name)).toEqual([]); // la v1 sigue ahí, pero la vigente fue borrada: no se «resucita» una anterior
    expect(events.at(-1)).toEqual({ kind: 'deleted', name, status: 404 });
    await versions('undelete', name, [2]);
    expect(await p.getSecrets(name)).toEqual([b, a]);
    await versions('destroy', name, [2]);
    expect(await p.getSecrets(name)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'deleted', name, status: 404 });
    expect(await put(name, c)).toBe(3);
    expect(await p.getSecrets(name)).toEqual([c]); // la v2 está destruida: no vuelve a valer
  });

  it('OpenBao caído y luego de vuelta: durante la caída ⇒ [] (tras el TTL), al volver se lee sin reiniciar', async () => {
    const name = fresh();
    const value = generateSecret();
    await put(name, value);
    const target = new URL(ADDR);
    const proxy = new TcpProxy({ host: target.hostname, port: Number(target.port) });
    await proxy.start();
    try {
      const events: OpenBaoEvent[] = [];
      const addr = `http://127.0.0.1:${proxy.port}`;
      const p = provider(mockToken, { addr, cacheTtlMs: 1_500 }, events);
      expect(await p.getSecrets(name)).toEqual([value]);
      await proxy.stop();
      expect(await p.getSecrets(name)).toEqual([value]); // dentro del TTL el caché breve responde (demora máxima declarada: OPENBAO_CACHE_TTL_MS)
      const down = await until(async () => ((await p.getSecrets(name)).length === 0 ? true : undefined), 10_000); // vencido el TTL: fail-closed
      expect(down).toBe(true);
      expect(events.some((e) => e.kind === 'unreachable' && e.name === name)).toBe(true);
      await proxy.start();
      expect(await until(async () => ((await p.getSecrets(name)).length === 1 ? await p.getSecrets(name) : undefined), 10_000)).toEqual([value]);
    } finally {
      await proxy.stop();
    }
  });

  it('OpenBao colgado (acepta y no responde) ⇒ [] dentro del tope de tiempo, sin colgar al llamante', async () => {
    const name = fresh();
    await put(name, generateSecret());
    const target = new URL(ADDR);
    const proxy = new TcpProxy({ host: target.hostname, port: Number(target.port) });
    proxy.hang = true;
    await proxy.start();
    try {
      const events: OpenBaoEvent[] = [];
      const started = Date.now();
      expect(await provider(mockToken, { addr: `http://127.0.0.1:${proxy.port}`, timeoutMs: 400 }, events).getSecrets(name)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(proxy.accepted).toBeGreaterThan(0);
      expect(events.map((e) => e.kind)).toEqual(['timeout']);
    } finally {
      await proxy.stop();
    }
  });

  it('el token solo lee su espacio: no escribe, no borra, no lista, no lee el otro modo (403 reales)', async () => {
    const name = fresh();
    await put(name, 'valor-sintetico-x');
    await put(name, 'valor-sintetico-live', 'live');
    const own = `${MOUNT}/data/${kvPath(name)}`;
    expect((await bao('GET', own, undefined, mockToken)).status).toBe(200);
    expect((await bao('POST', own, { data: { value: 'pisado' } }, mockToken)).status).toBe(403);
    expect((await bao('POST', `${MOUNT}/delete/${kvPath(name)}`, { versions: [1] }, mockToken)).status).toBe(403);
    expect((await bao('DELETE', `${MOUNT}/metadata/${kvPath(name)}`, undefined, mockToken)).status).toBe(403);
    expect((await bao('GET', `${MOUNT}/metadata/${PREFIX}/sandbox?list=true`, undefined, mockToken)).status).toBe(403);
    expect((await bao('GET', `${MOUNT}/data/${kvPath(name, 'live')}`, undefined, mockToken)).status).toBe(403);
    expect((await bao('GET', own)).body.data.data.value).toBe('valor-sintetico-x'); // y no se pisó
  });

  it('token revocado ⇒ 403 ⇒ [] (no queda el último valor)', async () => {
    const name = fresh();
    await put(name, generateSecret());
    const token = await tokenFor(POLICIES.mock);
    const events: OpenBaoEvent[] = [];
    const p = provider(token, {}, events);
    expect(await p.getSecrets(name)).toHaveLength(1);
    expect((await bao('POST', 'auth/token/revoke', { token })).status).toBe(204);
    expect(await p.getSecrets(name)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'denied', name, status: 403 });
  });
});

describe('P4.H2.M6 contra OpenBao real — inválido', () => {
  it('el token de un conector NO lee el espacio de otro: 403 real, [] y nunca se mezclan los valores', async () => {
    const mockName = fresh('MOCK');
    const qrName = fresh('MERCANTIL_QR');
    const mockValue = `mock-${generateSecret()}`;
    const qrValue = `qr-${generateSecret()}`;
    await put(mockName, mockValue);
    await put(qrName, qrValue);
    // En crudo, contra OpenBao: 403.
    expect((await bao('GET', `${MOUNT}/data/${kvPath(qrName)}`, undefined, mockToken)).status).toBe(403);
    expect((await bao('GET', `${MOUNT}/data/${kvPath(mockName)}`, undefined, qrToken)).status).toBe(403);
    // Con el proveedor: cada uno obtiene solo lo suyo.
    const mockEvents: OpenBaoEvent[] = [];
    const qrEvents: OpenBaoEvent[] = [];
    const asMock = provider(mockToken, {}, mockEvents);
    const asQr = provider(qrToken, {}, qrEvents);
    expect(await asMock.getSecrets(mockName)).toEqual([mockValue]);
    expect(await asQr.getSecrets(qrName)).toEqual([qrValue]);
    expect(await asMock.getSecrets(qrName)).toEqual([]);
    expect(await asQr.getSecrets(mockName)).toEqual([]);
    expect(mockEvents).toEqual([{ kind: 'denied', name: qrName, status: 403 }]);
    expect(qrEvents).toEqual([{ kind: 'denied', name: mockName, status: 403 }]);
    expect(JSON.stringify([mockEvents, qrEvents])).not.toMatch(/whsec_|mock-|qr-/);
  });

  it('el modo no se mezcla: un proveedor `live` con el token de sandbox no lee `live` (403), y sandbox no ve el valor de live', async () => {
    const name = fresh();
    await put(name, 'valor-sintetico-sandbox');
    await put(name, 'valor-sintetico-live', 'live');
    const events: OpenBaoEvent[] = [];
    expect(await provider(mockToken, { mode: 'live' }, events).getSecrets(name)).toEqual([]);
    expect(events).toEqual([{ kind: 'denied', name, status: 403 }]);
    expect(await provider(mockToken, { mode: 'sandbox' }).getSecrets(name)).toEqual(['valor-sintetico-sandbox']);
  });

  it('con ScopedSecretProvider el conector ni siquiera pregunta por el espacio de otro (cero llamadas a OpenBao)', async () => {
    const qrName = fresh('MERCANTIL_QR');
    await put(qrName, 'valor-sintetico-qr');
    const calls = counting();
    const scoped = new ScopedSecretProvider(provider(mockToken, { fetch: calls.fetch }), namespaceOf('mock'));
    expect(await scoped.getSecrets(qrName)).toEqual([]);
    expect(calls.urls).toEqual([]);
  });

  it('rutas con `..`, barras, consulta o mayúsculas/minúsculas raras ⇒ rechazadas SIN llegar a la red; el valor de otro conector no se obtiene', async () => {
    const qrName = fresh('MERCANTIL_QR');
    await put(qrName, 'valor-sintetico-qr-ajeno');
    const calls = counting();
    const events: OpenBaoEvent[] = [];
    const p = provider(qrToken, { fetch: calls.fetch }, events); // este token SÍ puede leer el QR: si el nombre se interpretara, saldría el valor
    const hostile = [
      `CONNECTOR_MOCK_X/../../${qrName}`,
      `../sandbox/${qrName}`,
      `${qrName}/../${qrName}`,
      `${qrName}?version=1`,
      `${qrName}%2F..%2F`,
      'CONNECTOR_MERCANTIL_QR_%2e%2e',
      `${qrName}\n`,
      qrName.toLowerCase(),
      `${MOUNT}/data/${kvPath(qrName)}`,
      '',
    ];
    for (const name of hostile) expect(await p.getSecrets(name)).toEqual([]);
    expect(calls.urls).toEqual([]);
    expect(events.every((e) => e.kind === 'rejected_name')).toBe(true);
    // Control positivo: el nombre limpio, con el mismo proveedor, sí llega a OpenBao y devuelve el valor.
    expect(await p.getSecrets(qrName)).toEqual(['valor-sintetico-qr-ajeno']);
    expect(calls.urls).toHaveLength(1);
  });

  it('AppRole con un secret_id inválido ⇒ [] y no se hace ninguna lectura', async () => {
    const name = fresh();
    await put(name, generateSecret());
    const calls = counting();
    const events: OpenBaoEvent[] = [];
    const p = provider('', { auth: { kind: 'approle', roleId, secretId: '00000000-0000-0000-0000-000000000000' }, fetch: calls.fetch }, events);
    expect(await p.getSecrets(name)).toEqual([]);
    expect(events).toEqual([{ kind: 'login_failed', status: 400 }]);
    expect(calls.urls.some((u) => u.includes('/data/'))).toBe(false);
  });
});

// ─────────────────────────────────────────── REQ-P4-6 con el secreto del conector `mock` sacado de OpenBao ───────────────────────────────────────────
describe('REQ-P4-6 con OpenBao real — flujo de cobros y callbacks, rotación, caída y revocación, sin fugas', () => {
  const logs: string[] = [];
  const originals = { writeSync: fs.writeSync, stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) };
  const responses: string[] = [];
  const CARD_TOKEN = 'tok_sentinelcardtoken0123456789';
  const PAYER = 'Juan Perez Quispe CI 7654321';
  const PAN = '4111111111111111';
  let t: TestApp;
  let proxy: TcpProxy;
  let bank: SimulatedBank;
  let mock: MockConnector;

  beforeAll(async () => {
    (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
      if (fd === 1 || fd === 2) logs.push(String(data));
      return (originals.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
    };
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (logs.push(String(chunk)), (originals.stdout as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (logs.push(String(chunk)), (originals.stderr as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stderr.write;
    const target = new URL(ADDR);
    proxy = new TcpProxy({ host: target.hostname, port: Number(target.port) });
    await proxy.start();
    t = await createTestApp({
      config: {
        secrets: { provider: 'openbao', addr: `http://127.0.0.1:${proxy.port}`, mount: MOUNT, pathPrefix: PREFIX, auth: { kind: 'token', token: mockToken }, cacheTtlMs: 0, rotationWindowMs: 60_000, timeoutMs: 1_500 },
      },
    });
    // El módulo de pruebas solo deja pasar `error`; se habilitan `warn` y `error` (en el proceso real los emite pino, ver «arranque real»).
    t.app.useLogger(new ConsoleLogger({ json: true, logLevels: ['warn', 'error'] }));
    bank = t.app.get(SIMULATED_BANK);
    mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
  }, 60_000);
  afterAll(async () => {
    (fs as { writeSync: unknown }).writeSync = originals.writeSync;
    process.stdout.write = originals.stdout as typeof process.stdout.write;
    process.stderr.write = originals.stderr as typeof process.stderr.write;
    await t.close();
    await proxy.stop();
  });

  const note = (r: { text?: string; body?: unknown }) => responses.push(`${r.text ?? ''}${JSON.stringify(r.body ?? '')}`);
  const deliver = async (headers: Record<string, string>, rawBody: Buffer) => {
    const r = await request(t.app.getHttpServer()).post('/callbacks/mock').set(headers).set('content-type', 'application/json').send(rawBody.toString('utf8'));
    note(r);
    return r;
  };
  /** Un cobro con su callback pendiente. */
  async function charge(over: Record<string, unknown> = {}): Promise<{ id: string; callback: ScheduledCallback }> {
    const r = await post(t.app, '/charges', chargeBody({ description: `${PAYER} ${PAN}`, ...over }, t.clock));
    note(r);
    expect(r.status).toBe(201);
    const callback = bank.dueCallbacks(t.clock.now()).find((c) => c.reference === r.body.id);
    expect(callback).toBeDefined();
    return { id: r.body.id as string, callback: callback as ScheduledCallback };
  }
  /** El pedido que el «banco» enviaría firmado SOLO con los secretos indicados. */
  async function signedWith(callback: ScheduledCallback, secrets: string[]): Promise<{ headers: Record<string, string>; rawBody: Buffer }> {
    const body = (await mock.signCallback(callback, t.clock.now())).rawBody; // el cuerpo es el mismo; cambia quién lo firma
    return { rawBody: body, headers: signedHeaders({ id: callback.eventId, timestamp: Math.floor(t.clock.now().getTime() / 1000), payload: body.toString('utf8'), secrets }) };
  }
  const statusOf = async (id: string) => (await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [id])).rows[0].provider_status as string;

  it('el secreto sale de OpenBao: firma y verifica, rota sin reiniciar, cierra la ventana, falla cerrado si OpenBao cae o el token se revoca; nada se filtra', async () => {
    expect(process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET).toBeUndefined(); // no hay secreto en el entorno: solo puede venir de OpenBao
    await t.reset();
    const v1 = generateSecret();
    const v2 = generateSecret();
    await put(MOCK_NAME, v1);

    // 1) Cobros y callback firmado con el secreto de OpenBao (el banco simulado firma con él; el endpoint lo verifica con él).
    const first = await charge();
    const signed = await mock.signCallback(first.callback, t.clock.now());
    const ok = await deliver(signed.headers, signed.rawBody);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ result: 'applied', charge_id: first.id });
    expect(await statusOf(first.id)).toBe('captured');
    note(await post(t.app, '/charges', chargeBody({ method: 'card', card_token: CARD_TOKEN, description: PAYER }, t.clock)));
    note(await post(t.app, '/charges', chargeBody({ amount_minor: PAN, description: PAYER }, t.clock)));
    // Firma mala, otro secreto, sin firma ⇒ 401.
    const second = await charge();
    for (const bad of [{ ...(await signedWith(second.callback, [generateSecret()])) }, { headers: {}, rawBody: signed.rawBody }]) expect((await deliver(bad.headers, bad.rawBody)).status).toBe(401);
    expect(await statusOf(second.id)).toBe('pending');

    // 2) Rotación SIN reiniciar: v2 es una versión nueva en KV v2. Vale la nueva y, dentro de la ventana, la anterior; un tercero no.
    expect(await put(MOCK_NAME, v2)).toBe(2);
    const withOld = await signedWith(second.callback, [v1]);
    expect((await deliver(withOld.headers, withOld.rawBody)).status).toBe(200); // firmado con la ANTERIOR
    const third = await charge();
    const withNew = await signedWith(third.callback, [v2]);
    expect((await deliver(withNew.headers, withNew.rawBody)).status).toBe(200); // firmado con la NUEVA
    const fourth = await charge();
    const withOther = await signedWith(fourth.callback, [generateSecret()]);
    expect((await deliver(withOther.headers, withOther.rawBody)).status).toBe(401);

    // 3) Se cierra la ventana (se borra la versión 1): la anterior deja de valer, la nueva sigue.
    await versions('delete', MOCK_NAME, [1]);
    const old = await signedWith(fourth.callback, [v1]);
    expect((await deliver(old.headers, old.rawBody)).status).toBe(401);
    const current = await signedWith(fourth.callback, [v2]);
    expect((await deliver(current.headers, current.rawBody)).status).toBe(200);

    // 4) OpenBao caído: callback bien firmado ⇒ 401 (fail-closed, no 500), el cobro no cambia; al volver, el MISMO pedido se acepta.
    const fifth = await charge();
    const retry = await signedWith(fifth.callback, [v2]);
    await proxy.stop();
    const refused = await deliver(retry.headers, retry.rawBody);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('unauthorized');
    expect(await statusOf(fifth.id)).toBe('pending');
    await proxy.start();
    // El proxy volvió en el mismo puerto: pero el app apunta a ese puerto, así que se lee sin reiniciar nada.
    expect((await deliver(retry.headers, retry.rawBody)).status).toBe(200);
    expect(await statusOf(fifth.id)).toBe('captured');

    // 5) Token revocado: 403 de OpenBao ⇒ 401 aquí; ningún valor viaja en la respuesta.
    const sixth = await charge();
    const afterRevoke = await signedWith(sixth.callback, [v2]);
    expect((await bao('POST', 'auth/token/revoke', { token: mockToken })).status).toBe(204);
    const denied = await deliver(afterRevoke.headers, afterRevoke.rawBody);
    expect(denied.status).toBe(401);
    expect(await statusOf(sixth.id)).toBe('pending');
    note(await get(t.app, '/connectors/health'));
    await new Promise((resolve) => setTimeout(resolve, 150)); // deja que pino vacíe

    // 6) Escaneo: ni el valor de ningún secreto (ni su cuerpo), ni los tokens, ni datos del pagador en logs, respuestas, eventos ni base.
    const tables = await t.db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [t.db.schema]);
    const dump: string[] = [];
    for (const { table_name: name } of tables.rows) {
      const rows = await t.db.pool.query(`SELECT row_to_json(x)::text AS j FROM "${name}" x`);
      dump.push(...rows.rows.map((r) => r.j as string));
    }
    expect(dump.length).toBeGreaterThan(20);
    const body = (s: string) => s.replace(/^whsec_/, '');
    const FORBIDDEN = [v1, body(v1), v2, body(v2), mockToken, qrToken, ROOT, roleId, secretId, CARD_TOKEN, PAYER, 'Juan Perez', PAN, 'CI 7654321'];
    const channels: Array<[string, string]> = [
      ['logs', logs.join('')],
      ['respuestas', responses.join('\n')],
      ['base de datos (incluye el outbox con los eventos)', dump.join('\n')],
    ];
    // No es vacuo: hay logs reales, el diagnóstico de OpenBao se registró (sin valores) y hay eventos publicados.
    expect(logs.join('')).toContain('request completed');
    expect(logs.join('')).toContain('OpenBao no entregó el secreto');
    expect(dump.join('')).toContain('connector.transaction.status_changed');
    for (const [where, text] of channels) {
      for (const secret of FORBIDDEN) expect({ where, secret: secret.slice(0, 6), found: text.includes(secret) }).toEqual({ where, secret: secret.slice(0, 6), found: false });
      expect(text).not.toMatch(/whsec_[A-Za-z0-9+/=]{16,}/);
    }
  }, 90_000);
});

// ─────────────────────────────────────────── arranque REAL (`node dist/main.js`, logs de pino) ───────────────────────────────────────────
describe('arranque real con SECRET_PROVIDER=openbao — configuración de entorno, OpenBao real y registros de pino', () => {
  const PROC_PREFIX = 'pay-connectors-proc';
  const url = new URL(TEST_DATABASE_URL);
  const dbEnv = { DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) };
  let db: IsolatedDatabase;
  let service: Started | undefined;

  beforeAll(async () => {
    buildService();
    db = await createIsolatedDatabase(SQL);
  }, 240_000);
  afterAll(async () => {
    if (service) await stop(service);
    await db.drop();
  });

  it('el proceso real lee el secreto del conector de OpenBao: firma válida ⇒ pasa la verificación; con el secreto destruido ⇒ 401 y un aviso sin valores', async () => {
    const name = MOCK_NAME;
    const secret = generateSecret();
    const policy = POLICIES.proc;
    expect((await bao('POST', `sys/policies/acl/${policy}`, { policy: `path "${MOUNT}/data/${PROC_PREFIX}/sandbox/${namespaceOf('mock')}*" { capabilities = ["read"] }` })).status).toBe(204);
    const token = await tokenFor(policy);
    issued.push(token);
    expect((await bao('POST', `${MOUNT}/data/${PROC_PREFIX}/sandbox/${name}`, { data: { value: secret } })).status).toBe(200);

    const port = await freePort();
    service = startService({
      ...dbEnv,
      PGOPTIONS: `-c search_path=${db.schema}`,
      PORT: String(port),
      POLLER_INTERVAL_MS: '0',
      HEALTH_INTERVAL_MS: '0',
      RECONCILE_INTERVAL_MS: '0',
      PAY_MODE: 'sandbox',
      SECRET_PROVIDER: 'openbao',
      OPENBAO_ADDR: ADDR,
      OPENBAO_TOKEN: token,
      OPENBAO_KV_MOUNT: MOUNT,
      OPENBAO_PATH_PREFIX: PROC_PREFIX,
      OPENBAO_CACHE_TTL_MS: '0',
    });
    const ready = await until(async () => ((await fetch(`http://127.0.0.1:${port}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
    if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);

    const body = JSON.stringify({ id: 'evt_procreal001', type: 'charge.status', reference: 'ch_inexistente0001', status: 'captured', occurred_at: new Date().toISOString(), amount_minor: 10000 });
    const post = async (secrets: string[]) =>
      fetch(`http://127.0.0.1:${port}/callbacks/mock`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...signedHeaders({ id: 'evt_procreal001', timestamp: Math.floor(Date.now() / 1000), payload: body, secrets }) }, body });
    // Firma con el secreto de OpenBao ⇒ la autenticación pasa (la referencia no existe: 200 con `contradiction` y sin cobro; no es 401); con otro secreto ⇒ 401.
    const accepted = await post([secret]);
    expect([accepted.status, await accepted.json()]).toEqual([200, { result: 'contradiction', charge_id: null }]); // pasó la verificación; la referencia no existe, no hay cobro que tocar
    expect((await post([generateSecret()])).status).toBe(401);
    // Se destruye la única versión: el proceso vivo, sin reiniciar, rechaza todo (fail-closed) y lo avisa.
    expect((await bao('POST', `${MOUNT}/destroy/${PROC_PREFIX}/sandbox/${name}`, { versions: [1] })).status).toBe(204);
    expect((await post([secret])).status).toBe(401);
    // pino escribe de forma asíncrona: se espera por la condición (el aviso en la salida del proceso), no un tiempo fijo.
    const running = service;
    await until(async () => (running.output().includes('OpenBao no entregó el secreto') ? true : undefined), 10_000);
    const output = service.output();
    expect(output).toContain('OpenBao no entregó el secreto');
    expect(output).toMatch(/"event":"deleted"/);
    expect(output).toContain(name);
    for (const forbidden of [secret, secret.replace(/^whsec_/, ''), token, ROOT, secretId, roleId]) expect(output).not.toContain(forbidden);
  }, 120_000);
});
