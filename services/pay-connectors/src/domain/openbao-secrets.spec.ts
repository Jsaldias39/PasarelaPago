import { loadConfig } from '../config';
import { isSafePath, OpenBaoSecretProvider, type OpenBaoEvent, type OpenBaoSecretOptions } from './openbao-secrets';

// [DOBLE] Un OpenBao en memoria que imita lo verificado contra el servidor real 2.7.2 (rutas, formas de respuesta y códigos). Cubre lo que el servidor real no
// puede producir a pedido (cuerpos ilegibles, redirecciones, cortes, el reloj). El comportamiento contra el OpenBao REAL está en `test/openbao.spec.ts`.
const NAME = 'CONNECTOR_MOCK_WEBHOOK_SECRET';
const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const V1 = 'valor-sintetico-uno-aaaaaaaaaaaaaaaa';
const V2 = 'valor-sintetico-dos-bbbbbbbbbbbbbbbb';
const V3 = 'valor-sintetico-tres-cccccccccccccc';

interface Version {
  value?: string;
  createdAt: number;
  deleted?: boolean;
  destroyed?: boolean;
}

class FakeBao {
  readonly kv = new Map<string, Version[]>();
  readonly calls: Array<{ url: string; method: string; token: string | undefined; redirect: string | undefined }> = [];
  clock = T0;
  failWith: 'throw' | 'timeout' | 'redirect' | 'http500' | 'forbidden' | 'garbage' | 'login-fail' | undefined;
  loginLease = 3600;
  logins = 0;

  put(path: string, value: string, createdAt = this.clock): void {
    const versions = this.kv.get(path) ?? [];
    versions.push({ value, createdAt });
    this.kv.set(path, versions);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ url, method: init?.method ?? 'GET', token: headers['X-Vault-Token'], redirect: init?.redirect });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/approle/login')) {
      this.logins += 1;
      if (this.failWith === 'login-fail') return json(400, { errors: ['invalid role or secret ID'] });
      return json(200, { auth: { client_token: `tok-${this.logins}`, lease_duration: this.loginLease } });
    }
    if (this.failWith === 'throw') throw new TypeError('fetch failed');
    if (this.failWith === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (this.failWith === 'redirect') return new Response(null, { status: 307, headers: { location: 'http://otro.invalid/' } });
    if (this.failWith === 'http500') return json(500, { errors: ['boom'] });
    if (this.failWith === 'forbidden') return json(403, { errors: ['permission denied'] });
    if (this.failWith === 'garbage') return new Response('<html>no es json</html>', { status: 200 });
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v1\/secret\/data\//, '');
    const versions = this.kv.get(path);
    if (!versions) return json(404, { errors: [] });
    const wanted = parsed.searchParams.has('version') ? Number(parsed.searchParams.get('version')) : versions.length;
    const entry = versions[wanted - 1];
    if (!entry) return json(404, { errors: [] });
    const metadata = { created_time: new Date(entry.createdAt).toISOString(), deletion_time: entry.deleted ? new Date(this.clock).toISOString() : '', destroyed: entry.destroyed === true, version: wanted };
    if (entry.deleted || entry.destroyed) return json(404, { data: { data: null, metadata } });
    return json(200, { data: { data: { value: entry.value }, metadata } });
  };
}

const PATH = `pay-connectors/sandbox/${NAME}`;

function make(bao: FakeBao, over: Partial<OpenBaoSecretOptions> = {}, events: OpenBaoEvent[] = []): OpenBaoSecretProvider {
  return new OpenBaoSecretProvider({
    addr: 'http://bao.invalid:8200/',
    mode: 'sandbox',
    mount: 'secret',
    pathPrefix: 'pay-connectors',
    auth: { kind: 'token', token: 'tok-sintetico' },
    cacheTtlMs: 5_000,
    rotationWindowMs: 60_000,
    timeoutMs: 1_000,
    fetch: bao.fetch as typeof fetch,
    now: () => bao.clock,
    onEvent: (event) => events.push(event),
    ...over,
  });
}

describe('OpenBaoSecretProvider — correcto', () => {
  it('lee la última versión de <mount>/data/<prefijo>/<modo>/<NOMBRE> con X-Vault-Token y sin seguir redirecciones', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1);
    expect(await make(bao).getSecrets(NAME)).toEqual([V1]);
    expect(bao.calls).toEqual([{ url: `http://bao.invalid:8200/v1/secret/data/${PATH}`, method: 'GET', token: 'tok-sintetico', redirect: 'manual' }]);
  });

  it('el modo separa las rutas: sandbox no ve lo de live y al revés', async () => {
    const bao = new FakeBao();
    bao.put(`pay-connectors/live/${NAME}`, V2);
    expect(await make(bao, { mode: 'sandbox' }).getSecrets(NAME)).toEqual([]);
    expect(await make(bao, { mode: 'live' }).getSecrets(NAME)).toEqual([V2]);
  });

  it('rotación sin corte: la nueva versión y la anterior valen dentro de la ventana; la anterior deja de valer al cerrarse', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1, T0 - 600_000);
    bao.put(PATH, V2, T0 - 10_000); // creada hace 10 s, ventana de 60 s
    const provider = make(bao, { cacheTtlMs: 0 });
    expect(await provider.getSecrets(NAME)).toEqual([V2, V1]);
    bao.clock = T0 + 49_000; // 59 s desde la creación: sigue dentro
    expect(await provider.getSecrets(NAME)).toEqual([V2, V1]);
    bao.clock = T0 + 51_000; // 61 s: fuera de la ventana
    expect(await provider.getSecrets(NAME)).toEqual([V2]);
  });

  it('una versión nueva se ve al vencer el TTL o con invalidate(), sin reiniciar', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1, T0 - 600_000);
    const provider = make(bao);
    expect(await provider.getSecrets(NAME)).toEqual([V1]);
    bao.put(PATH, V2);
    expect(await provider.getSecrets(NAME)).toEqual([V1]); // dentro del TTL: caché
    provider.invalidate(NAME);
    expect(await provider.getSecrets(NAME)).toEqual([V2, V1]);
    bao.put(PATH, V3);
    bao.clock += 5_001; // vence el TTL
    expect(await provider.getSecrets(NAME)).toEqual([V3, V2]);
  });

  it('el caché es breve: dentro del TTL no vuelve a OpenBao; con TTL 0 siempre vuelve; peticiones simultáneas comparten una lectura', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1);
    const cached = make(bao);
    await cached.getSecrets(NAME);
    await cached.getSecrets(NAME);
    expect(bao.calls).toHaveLength(1);
    bao.calls.length = 0;
    const uncached = make(bao, { cacheTtlMs: 0 });
    await uncached.getSecrets(NAME);
    await uncached.getSecrets(NAME);
    expect(bao.calls).toHaveLength(2);
    bao.calls.length = 0;
    const burst = make(bao);
    expect(await Promise.all([burst.getSecrets(NAME), burst.getSecrets(NAME), burst.getSecrets(NAME)])).toEqual([[V1], [V1], [V1]]);
    expect(bao.calls).toHaveLength(1);
  });

  it('AppRole: se autentica una vez, reutiliza el token y se reautentica al 80 % de su vida', async () => {
    const bao = new FakeBao();
    bao.loginLease = 100;
    bao.put(PATH, V1);
    const provider = make(bao, { auth: { kind: 'approle', roleId: 'rol-sintetico', secretId: 'sid-sintetico' }, cacheTtlMs: 0 });
    await provider.getSecrets(NAME);
    await provider.getSecrets(NAME);
    expect(bao.logins).toBe(1);
    expect(bao.calls.filter((c) => !c.url.endsWith('/login')).every((c) => c.token === 'tok-1')).toBe(true);
    bao.clock += 81_000; // 81 s de 100 s
    await provider.getSecrets(NAME);
    expect(bao.logins).toBe(2);
    expect(bao.calls[bao.calls.length - 1]?.token).toBe('tok-2');
  });
});

describe('OpenBaoSecretProvider — límite: fail-closed', () => {
  it('secreto ausente ⇒ []', async () => {
    const events: OpenBaoEvent[] = [];
    expect(await make(new FakeBao(), {}, events).getSecrets(NAME)).toEqual([]);
    expect(events).toEqual([{ kind: 'missing', name: NAME, status: 404 }]);
  });

  it('la última versión borrada o destruida ⇒ [] (no se cae a una anterior)', async () => {
    for (const how of ['deleted', 'destroyed'] as const) {
      const bao = new FakeBao();
      bao.put(PATH, V1, T0 - 600_000);
      bao.put(PATH, V2, T0 - 1_000);
      (bao.kv.get(PATH) as Version[])[1]![how] = true;
      const events: OpenBaoEvent[] = [];
      expect(await make(bao, {}, events).getSecrets(NAME)).toEqual([]);
      expect(events).toEqual([{ kind: 'deleted', name: NAME, status: 404 }]);
    }
  });

  it('la versión anterior borrada o destruida: vale solo la nueva (se cerró la ventana a mano)', async () => {
    for (const how of ['deleted', 'destroyed'] as const) {
      const bao = new FakeBao();
      bao.put(PATH, V1, T0 - 600_000);
      bao.put(PATH, V2, T0 - 1_000);
      (bao.kv.get(PATH) as Version[])[0]![how] = true;
      expect(await make(bao).getSecrets(NAME)).toEqual([V2]);
    }
  });

  it('dos versiones con el mismo valor no se duplican; una versión 1 no busca anterior; un created_time ilegible cuenta como fuera de ventana', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1, T0 - 1_000);
    bao.put(PATH, V1, T0 - 500);
    expect(await make(bao).getSecrets(NAME)).toEqual([V1]);
    const single = new FakeBao();
    single.put(PATH, V1);
    await make(single).getSecrets(NAME);
    expect(single.calls).toHaveLength(1);
    const odd = new FakeBao();
    odd.put(PATH, V1, T0 - 1_000);
    odd.put(PATH, V2, T0 - 500);
    const realFetch = odd.fetch;
    const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await realFetch(input, init);
      const text = (await response.text()).replace(/"created_time":"[^"]*"/, '"created_time":"no-es-fecha"');
      return new Response(text, { status: response.status });
    };
    expect(await make(odd, { fetch: patched as typeof fetch }).getSecrets(NAME)).toEqual([V2]);
  });

  it('cualquier fallo de OpenBao ⇒ [] y NO se cachea: al volver, la siguiente lectura ya funciona', async () => {
    for (const failure of ['throw', 'timeout', 'redirect', 'http500', 'forbidden', 'garbage'] as const) {
      const bao = new FakeBao();
      bao.put(PATH, V1);
      const events: OpenBaoEvent[] = [];
      const provider = make(bao, {}, events);
      bao.failWith = failure;
      expect(await provider.getSecrets(NAME)).toEqual([]);
      expect(events).toHaveLength(1);
      bao.failWith = undefined;
      expect(await provider.getSecrets(NAME)).toEqual([V1]);
    }
  });

  it('respuestas 200 mal formadas (sin value, vacío, no texto, sin metadata) ⇒ []', async () => {
    const bodies = [{ data: { data: {}, metadata: { version: 1 } } }, { data: { data: { value: '' }, metadata: { version: 1 } } }, { data: { data: { value: 42 }, metadata: { version: 1 } } }, { data: { data: { value: 'x' } } }, { data: { data: { value: 'x' }, metadata: { version: 0 } } }, { data: { data: null, metadata: { version: 1 } } }, [], 'cadena'];
    for (const body of bodies) {
      const events: OpenBaoEvent[] = [];
      const fetchStub = async () => new Response(JSON.stringify(body), { status: 200 });
      expect(await make(new FakeBao(), { fetch: fetchStub as unknown as typeof fetch }, events).getSecrets(NAME)).toEqual([]);
      expect(events.map((e) => e.kind)).toEqual(['malformed']);
    }
  });

  it('login de AppRole rechazado ⇒ [] sin llegar a leer; un 403 descarta el token para reautenticar', async () => {
    const bao = new FakeBao();
    bao.put(PATH, V1);
    const events: OpenBaoEvent[] = [];
    const provider = make(bao, { auth: { kind: 'approle', roleId: 'r', secretId: 's' }, cacheTtlMs: 0 }, events);
    bao.failWith = 'login-fail';
    expect(await provider.getSecrets(NAME)).toEqual([]);
    expect(events).toEqual([{ kind: 'login_failed', status: 400 }]);
    expect(bao.calls.some((c) => c.url.includes('/data/'))).toBe(false);
    bao.failWith = undefined;
    expect(await provider.getSecrets(NAME)).toEqual([V1]);
    bao.failWith = 'forbidden';
    expect(await provider.getSecrets(NAME)).toEqual([]);
    bao.failWith = undefined;
    const before = bao.logins;
    expect(await provider.getSecrets(NAME)).toEqual([V1]);
    expect(bao.logins).toBe(before + 1);
  });
});

describe('OpenBaoSecretProvider — inválido: la entrada no se sale de su ruta', () => {
  it('nombres con rutas, comillas, consulta, mayúsculas/minúsculas mezcladas o fuera del espacio CONNECTOR_… ⇒ [] SIN llamar a OpenBao', async () => {
    const bao = new FakeBao();
    const events: OpenBaoEvent[] = [];
    const provider = make(bao, {}, events);
    const hostile = ['', 'CONNECTOR_MOCK', 'CONNECTOR_', '../CONNECTOR_MOCK_X', 'CONNECTOR_MOCK_../X', 'CONNECTOR_MOCK_A/B', 'CONNECTOR_MOCK_A\\B', 'CONNECTOR_MOCK_X?version=1', 'CONNECTOR_MOCK_X#y', 'CONNECTOR_MOCK_X%2e%2e', 'CONNECTOR_MOCK_X%2F', 'connector_mock_x', 'Connector_Mock_X', 'CONNECTOR_MOCK_X ', ' CONNECTOR_MOCK_X', 'CONNECTOR_MOCK_X\n', 'CONNECTOR_MOCK_X\u0000', 'CONNECTOR__X', 'CONNECTOR_MOCK_X_', 'DB_PASSWORD', 'PATH', 'secret/data/otro', `CONNECTOR_MOCK_${'A'.repeat(200)}`, 'CONNECTOR_MOCK_ÑANDÚ'];
    for (const name of hostile) expect(await provider.getSecrets(name)).toEqual([]);
    expect(await provider.getSecrets(undefined as unknown as string)).toEqual([]);
    expect(await provider.getSecrets({ toString: () => NAME } as unknown as string)).toEqual([]);
    expect(bao.calls).toEqual([]);
    expect(events.every((e) => e.kind === 'rejected_name' && e.name === undefined)).toBe(true); // el nombre hostil no se registra
  });

  it('mount y prefijo se validan al construir', () => {
    for (const bad of ['', '..', 'a/../b', 'a//b', '/a', 'a/', 'A', 'a b', 'a?b', 'a%2fb', '.', 'a/./b']) {
      expect(isSafePath(bad)).toBe(false);
      expect(() => make(new FakeBao(), { mount: bad })).toThrow(/mount o prefijo/);
      expect(() => make(new FakeBao(), { pathPrefix: bad })).toThrow(/mount o prefijo/);
    }
    expect(isSafePath('pay-connectors')).toBe(true);
    expect(isSafePath('pay/connectors_1')).toBe(true);
  });
});

describe('OpenBaoSecretProvider — nunca registra valores', () => {
  it('ni eventos ni errores de ningún fallo contienen un valor, un token o un cuerpo de OpenBao', async () => {
    const events: OpenBaoEvent[] = [];
    const sentinels = [V1, V2, V3, 'tok-sintetico', 'sid-sintetico', 'permission denied', 'boom', 'no es json'];
    for (const failure of [undefined, 'throw', 'timeout', 'redirect', 'http500', 'forbidden', 'garbage', 'login-fail'] as const) {
      const bao = new FakeBao();
      bao.put(PATH, V1, T0 - 600_000);
      bao.put(PATH, V2, T0 - 1_000);
      bao.failWith = failure;
      const provider = make(bao, { auth: failure === 'login-fail' ? { kind: 'approle', roleId: 'r', secretId: 'sid-sintetico' } : { kind: 'token', token: 'tok-sintetico' } }, events);
      await provider.getSecrets(NAME);
    }
    await make(new FakeBao(), {}, events).getSecrets('../x');
    const dump = JSON.stringify(events);
    expect(events.length).toBeGreaterThan(6);
    for (const sentinel of sentinels) expect(dump).not.toContain(sentinel);
  });

  it('un onEvent que falla no rompe la lectura', async () => {
    const bao = new FakeBao();
    expect(await make(bao, { onEvent: () => { throw new Error('diagnóstico roto'); } }).getSecrets(NAME)).toEqual([]);
  });
});

describe('configuración: SECRET_PROVIDER (P4.H2.M6)', () => {
  const base = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' };
  const sandbox = { ...base, PAY_MODE: 'sandbox' };
  const live = { ...base, PAY_MODE: 'live' };
  const bao = { OPENBAO_ADDR: 'https://openbao.invalid:8200', OPENBAO_TOKEN: 'tok-sintetico-de-prueba' };

  it('correcto: sandbox sin variable ⇒ env; openbao con token o con AppRole; los valores por defecto son los documentados', () => {
    expect(loadConfig({ ...sandbox }).secrets).toEqual({ provider: 'env' });
    expect(loadConfig({ ...sandbox, SECRET_PROVIDER: 'env' }).secrets).toEqual({ provider: 'env' });
    expect(loadConfig({ ...sandbox, SECRET_PROVIDER: 'openbao', ...bao }).secrets).toEqual({
      provider: 'openbao',
      addr: 'https://openbao.invalid:8200',
      mount: 'secret',
      pathPrefix: 'pay-connectors',
      auth: { kind: 'token', token: 'tok-sintetico-de-prueba' },
      cacheTtlMs: 5_000,
      rotationWindowMs: 86_400_000,
      timeoutMs: 3_000,
    });
    const approle = loadConfig({ ...live, SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: bao.OPENBAO_ADDR, OPENBAO_ROLE_ID: 'rol', OPENBAO_SECRET_ID: 'sid', OPENBAO_KV_MOUNT: 'kv-pay', OPENBAO_PATH_PREFIX: 'a/b', OPENBAO_CACHE_TTL_MS: '0', OPENBAO_ROTATION_WINDOW_MS: '60000', OPENBAO_TIMEOUT_MS: '500' }).secrets;
    expect(approle).toMatchObject({ provider: 'openbao', mount: 'kv-pay', pathPrefix: 'a/b', auth: { kind: 'approle', roleId: 'rol', secretId: 'sid' }, cacheTtlMs: 0, rotationWindowMs: 60_000, timeoutMs: 500 });
  });

  it('límite: live exige SECRET_PROVIDER (sin valor por defecto) y solo admite openbao, con https; sandbox admite http', () => {
    expect(() => loadConfig({ ...live })).toThrow(/SECRET_PROVIDER es obligatorio bajo PAY_MODE=live/);
    expect(() => loadConfig({ ...live, SECRET_PROVIDER: '' })).toThrow(/SECRET_PROVIDER es obligatorio/);
    expect(() => loadConfig({ ...live, SECRET_PROVIDER: 'env' })).toThrow(/no admite SECRET_PROVIDER=env/);
    expect(() => loadConfig({ ...live, SECRET_PROVIDER: 'openbao', ...bao, OPENBAO_ADDR: 'http://openbao.invalid:8200' })).toThrow(/https bajo PAY_MODE=live/);
    expect(loadConfig({ ...sandbox, SECRET_PROVIDER: 'openbao', ...bao, OPENBAO_ADDR: 'http://127.0.0.1:54200' }).secrets).toMatchObject({ addr: 'http://127.0.0.1:54200' });
  });

  it('inválido: proveedor desconocido, falta la dirección o la credencial, las dos credenciales, dirección con ruta/credenciales, mount o prefijo con `..`, números malos', () => {
    const open = { ...sandbox, SECRET_PROVIDER: 'openbao' };
    expect(() => loadConfig({ ...sandbox, SECRET_PROVIDER: 'vault' })).toThrow(/SECRET_PROVIDER debe ser openbao o env/);
    expect(() => loadConfig({ ...sandbox, SECRET_PROVIDER: 'OpenBao' })).toThrow(/SECRET_PROVIDER debe ser/);
    expect(() => loadConfig({ ...open, OPENBAO_TOKEN: 't' })).toThrow(/OPENBAO_ADDR/);
    expect(() => loadConfig({ ...open, OPENBAO_ADDR: bao.OPENBAO_ADDR })).toThrow(/Falta la credencial de OpenBao/);
    expect(() => loadConfig({ ...open, OPENBAO_ADDR: bao.OPENBAO_ADDR, OPENBAO_ROLE_ID: 'solo-rol' })).toThrow(/Falta la credencial de OpenBao/);
    expect(() => loadConfig({ ...open, ...bao, OPENBAO_ROLE_ID: 'r', OPENBAO_SECRET_ID: 's' })).toThrow(/excluyentes/);
    for (const addr of ['no-es-url', 'ftp://x.invalid', 'https://usuario:clave@x.invalid', 'https://x.invalid/v1/secret']) expect(() => loadConfig({ ...open, ...bao, OPENBAO_ADDR: addr })).toThrow(/OPENBAO_ADDR/);
    for (const mount of ['../secret', 'a b', 'A', 'a/../b']) expect(() => loadConfig({ ...open, ...bao, OPENBAO_KV_MOUNT: mount })).toThrow(/OPENBAO_KV_MOUNT/);
    for (const prefix of ['..', 'a/../b', 'a//b', '/a']) expect(() => loadConfig({ ...open, ...bao, OPENBAO_PATH_PREFIX: prefix })).toThrow(/OPENBAO_PATH_PREFIX/);
    expect(() => loadConfig({ ...open, ...bao, OPENBAO_TIMEOUT_MS: '0' })).toThrow(/OPENBAO_TIMEOUT_MS/);
    expect(() => loadConfig({ ...open, ...bao, OPENBAO_CACHE_TTL_MS: '-1' })).toThrow(/OPENBAO_CACHE_TTL_MS/);
  });

  it('los mensajes de error de configuración no repiten el token ni el secret id', () => {
    const messages: string[] = [];
    const attempts: Array<Record<string, string>> = [
      { ...sandbox, SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'no-es-url', OPENBAO_TOKEN: 'TOKEN-CENTINELA-123' },
      { ...sandbox, SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: bao.OPENBAO_ADDR, OPENBAO_TOKEN: 'TOKEN-CENTINELA-123', OPENBAO_SECRET_ID: 'SID-CENTINELA-456' },
      { ...live, SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'http://x.invalid', OPENBAO_TOKEN: 'TOKEN-CENTINELA-123' },
      { ...sandbox, SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: bao.OPENBAO_ADDR, OPENBAO_SECRET_ID: 'SID-CENTINELA-456' },
    ];
    for (const env of attempts) {
      try {
        loadConfig(env);
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(4);
    for (const sentinel of ['TOKEN-CENTINELA-123', 'SID-CENTINELA-456']) expect(messages.join('\n')).not.toContain(sentinel);
  });
});
