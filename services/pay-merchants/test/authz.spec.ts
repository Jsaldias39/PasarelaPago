import $RefParser from '@apidevtools/json-schema-ref-parser';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { FsObjectStore } from '../src/kyc/object-store';
import { DenyAllOperatorAuthenticator, type OperatorAuthenticator } from '../src/operators/operator-auth';
import { OperatorAuthenticatorDouble, OPERATORS, bearer } from './doubles/operator-auth.double';
import { CONTRACT_BACKOFFICE, CONTRACT_PUBLIC, createTestContext, type TestContext } from './support/app';
import { merchantInput, pdf } from './support/fixtures';
import { activeMerchant, bo, createMerchant, uniqueKey, uploadAllDocs } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

type Route = { method: string; path: string };
const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/** Rutas realmente montadas en Express, con `:param` pasado a `{param}`. */
function mountedRoutes(c: TestContext): Route[] {
  const instance = c.app.getHttpAdapter().getInstance() as { router?: { stack: any[] }; _router?: { stack: any[] } };
  const stack = (instance.router ?? instance._router)?.stack ?? [];
  const routes: Route[] = [];
  for (const layer of stack) {
    if (!layer.route || String(layer.route.path).includes('*')) continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method, path: String(layer.route.path).replace(/:([A-Za-z]+)/g, '{$1}') });
    }
  }
  return routes;
}

async function contractOps(file: string): Promise<(Route & { role?: string })[]> {
  const doc = (await $RefParser.parse(file)) as { paths: Record<string, Record<string, { 'x-owner'?: string; 'x-required-role'?: string }>> };
  const ops: (Route & { role?: string })[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      // De la API pública, pay-merchants sirve el perfil y las claves; los mandatos son de pay-schedules.
      if (file === CONTRACT_PUBLIC && !(op['x-owner'] === 'P5' && (path === '/merchants/me' || path.startsWith('/api_keys')))) continue;
      ops.push({ method, path, role: op['x-required-role'] });
    }
  }
  return ops;
}

const key = (r: Route): string => `${r.method.toUpperCase()} ${r.path}`;
const concrete = (path: string, ids: { id: string; keyId: string }): string => path.replace('{id}', ids.id).replace('{keyId}', ids.keyId);
const ROLES = ['merchant_operator', 'kyc_reviewer', 'legal_admin', 'pricing_admin', 'security_operator'];
const OPERATOR_FOR_ROLE: Record<string, string> = { merchant_operator: 'op-merchant', kyc_reviewer: 'op-kyc', legal_admin: 'op-legal', pricing_admin: 'op-pricing', security_operator: 'op-security' };

describe('cobertura de rutas contra los contratos', () => {
  it('toda ruta montada está en el contrato público (P5) o en la propuesta de back-office, y al revés', async () => {
    const mounted = mountedRoutes(ctx).filter((r) => !r.path.startsWith('/health')).map(key).sort();
    const declared = [...(await contractOps(CONTRACT_PUBLIC)), ...(await contractOps(CONTRACT_BACKOFFICE))].map(key).sort();
    expect(mounted.length).toBeGreaterThan(15);
    expect(mounted).toEqual(declared);
  });
});

describe('matriz de autorización negativa (REQ-P5-5, regla 80.2.3)', () => {
  it('cada ruta de back-office exige servicio pay-backoffice, token válido y el rol declarado en el contrato', async () => {
    const id = await activeMerchant(ctx, 500);
    const created = await request(ctx.server).post('/api_keys').set('x-service-id', 'pay-edge').set('x-merchant-id', id).set('idempotency-key', uniqueKey()).send({ mode: 'test' });
    const ids = { id, keyId: created.body.id as string };
    const ops = (await contractOps(CONTRACT_BACKOFFICE)).filter((o) => o.role);
    expect(ops.length).toBe(13);
    const failures: string[] = [];
    for (const op of ops) {
      const path = concrete(op.path, ids);
      const call = () => request(ctx.server)[op.method as 'get'](path);
      const expectStatus = async (label: string, req: request.Test, allowed: number[]) => {
        const res = await req;
        if (!allowed.includes(res.status)) failures.push(`${key(op)} · ${label}: ${res.status} (esperado ${allowed.join('/')})`);
      };
      await expectStatus('sin x-service-id', call().set('authorization', bearer('op-admin')), [401, 403]);
      await expectStatus('servicio pay-edge', call().set('x-service-id', 'pay-edge').set('authorization', bearer('op-admin')), [403]);
      await expectStatus('servicio pay-payments', call().set('x-service-id', 'pay-payments').set('authorization', bearer('op-admin')), [403]);
      await expectStatus('sin token', call().set('x-service-id', 'pay-backoffice'), [401]);
      await expectStatus('token desconocido', call().set('x-service-id', 'pay-backoffice').set('authorization', 'Bearer op-hacker'), [401]);
      await expectStatus('operador sin roles', call().set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-norole')), [403]);
      for (const wrong of ROLES.filter((r) => r !== op.role)) {
        await expectStatus(`rol ${wrong}`, call().set('x-service-id', 'pay-backoffice').set('authorization', bearer(OPERATOR_FOR_ROLE[wrong])), [403]);
      }
    }
    expect(failures).toEqual([]);
  });

  it('cada rol declarado SÍ pasa la guardia en su ruta (no es 401 ni 403)', async () => {
    const id = await createMerchant(ctx, 501);
    const ops = (await contractOps(CONTRACT_BACKOFFICE)).filter((o) => o.role);
    for (const op of ops) {
      const res = await request(ctx.server)[op.method as 'get'](concrete(op.path, { id, keyId: 'key_aaaaaaaaaaaa' })).set('x-service-id', 'pay-backoffice').set('authorization', bearer(OPERATOR_FOR_ROLE[op.role as string]));
      expect({ op: key(op), status: res.status }).not.toMatchObject({ status: 401 });
      expect({ op: key(op), status: res.status }).not.toMatchObject({ status: 403 });
    }
  });

  it('las rutas públicas solo las abre pay-edge: cualquier otro servicio, o ninguno, es rechazado', async () => {
    const id = await createMerchant(ctx, 502);
    const ops = await contractOps(CONTRACT_PUBLIC);
    expect(ops.length).toBe(4 + 1); // me, api_keys (post/get), rotate, delete
    for (const op of ops) {
      const path = concrete(op.path, { id, keyId: 'key_aaaaaaaaaaaa' });
      for (const service of [undefined, 'pay-backoffice', 'pay-payments', 'pay-ledger']) {
        const req = request(ctx.server)[op.method as 'get'](path).set('x-merchant-id', id).set('idempotency-key', uniqueKey());
        if (service) req.set('x-service-id', service);
        const res = op.method === 'post' ? await req.send({ mode: 'test' }) : await req;
        expect({ op: key(op), service, ok: [401, 403].includes(res.status) }).toEqual({ op: key(op), service, ok: true });
      }
    }
  });

  it('un operador autenticado pero sin llamar por pay-backoffice no entra (la credencial sola no basta)', async () => {
    const id = await createMerchant(ctx, 503);
    const res = await request(ctx.server).get(`/merchants/${id}`).set('x-service-id', 'pay-edge').set('authorization', bearer('op-admin'));
    expect(res.status).toBe(403);
  });

  it('el operador de otra credencial no puede hacerse pasar por otro: `recorded_by`/`uploaded_by`/`published_by` salen del token', async () => {
    const id = await createMerchant(ctx, 504);
    await uploadAllDocs(ctx, id);
    const { rows } = await ctx.db.pool.query('SELECT DISTINCT uploaded_by FROM kyc_documents WHERE merchant_id = $1', [id]);
    expect(rows).toEqual([{ uploaded_by: OPERATORS['op-kyc'].sub }]);
  });
});

describe('verificador de operadores', () => {
  it('por defecto falla cerrado: sin verificador configurado NINGUNA ruta de back-office abre, ni con un token plausible', async () => {
    const deny: OperatorAuthenticator = new DenyAllOperatorAuthenticator();
    expect(await deny.authenticate('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeNull();
    const closed = await createTestContext({ realOperatorAuthenticator: true });
    try {
      const ops = (await contractOps(CONTRACT_BACKOFFICE)).filter((o) => o.role);
      for (const op of ops) {
        const res = await request(closed.server)[op.method as 'get'](concrete(op.path, { id: 'mc_aaaaaaaaaaaa', keyId: 'key_aaaaaaaaaaaa' })).set('x-service-id', 'pay-backoffice').set('authorization', bearer('op-admin'));
        expect({ op: key(op), status: res.status }).toEqual({ op: key(op), status: 401 });
      }
    } finally {
      await closed.close();
    }
  });

  describe('[DOBLE] OperatorAuthenticatorDouble: no es el verificador real, solo entiende `Bearer op-<nombre>`', () => {
    const double = new OperatorAuthenticatorDouble();
    it('correcto: reconoce a cada operador declarado con su sub y sus roles', async () => {
      for (const [name, identity] of Object.entries(OPERATORS)) expect(await double.authenticate(`Bearer ${name}`)).toEqual(identity);
    });
    it('límite: mayúsculas, espacios de más, sufijos y prefijos vecinos NO se aceptan', async () => {
      for (const header of ['Bearer op-ADMIN', 'bearer op-admin', 'Bearer  op-admin', 'Bearer op-admin ', ' Bearer op-admin', 'Bearer op-admin-2', 'Bearer op-', 'Bearer op-admin\n']) {
        expect({ header, identity: await double.authenticate(header) }).toEqual({ header, identity: null });
      }
    });
    it('inválido: ausente, esquema ajeno, JWT real, operador desconocido o prototipo ⇒ null, sin lanzar', async () => {
      for (const header of [undefined, '', 'Basic b3AtYWRtaW4=', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x', 'Bearer op-hacker', 'Bearer op-constructor', 'Bearer op-toString']) {
        expect({ header, identity: await double.authenticate(header) }).toEqual({ header, identity: null });
      }
    });
  });
});

describe('FsObjectStore [DEV]: almacén de documentos KYC', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'p5-store-'));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('correcto: guarda, lee y borra con la clave exacta; no sobrescribe (wx)', async () => {
    const store = new FsObjectStore(dir);
    const objectKey = 'kyc/mc_abcdefghij12/kd_abcdefghij12';
    await store.put(objectKey, pdf('uno'));
    expect((await store.get(objectKey)).equals(pdf('uno'))).toBe(true);
    await expect(store.put(objectKey, pdf('dos'))).rejects.toThrow();
    expect((await store.get(objectKey)).equals(pdf('uno'))).toBe(true);
    await store.delete(objectKey);
    await expect(store.get(objectKey)).rejects.toThrow();
  });

  it('límite e inválido: toda clave que no tenga la forma exacta se rechaza (recorrido de directorios, absolutas, nulos, longitudes)', async () => {
    const store = new FsObjectStore(dir);
    const bad = [
      '../fuera', 'kyc/../../fuera', '/etc/passwd', 'kyc/mc_abcdefghij12/../../../x', 'kyc/mc_abcdefghij12/kd_abcdefghij12/extra',
      'kyc/mc_abcdefghij12/kd_abcdefghij12\0', 'kyc/mc_ABCDEFGHIJ12/kd_abcdefghij12', 'kyc/mc_abc/kd_abc', `kyc/mc_${'a'.repeat(41)}/kd_abcdefghij12`, '', 'kyc/mc_abcdefghij12\\kd_abcdefghij12',
    ];
    for (const objectKey of bad) {
      await expect(store.put(objectKey, Buffer.from('x'))).rejects.toThrow(RangeError);
      await expect(store.get(objectKey)).rejects.toThrow(RangeError);
    }
  });
});

describe('privacidad: nombres, NIT y documentos no salen por logs, eventos ni errores (regla 90.2)', () => {
  it('con datos sintéticos centinela recorriendo todo el flujo, ningún canal de salida los contiene', async () => {
    const input = { ...merchantInput(600), legal_name: 'CENTINELA-RAZON-SOCIAL-600', display_name: 'CENTINELA-FANTASIA-600', tax_id: '1999000600' };
    const created = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send(input);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const centinelas = ['CENTINELA-RAZON-SOCIAL-600', '1999000600', 'documento sintético de prueba'];
    const outputs: string[] = [];

    await uploadAllDocs(ctx, id);
    outputs.push(JSON.stringify((await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'approved', risk_level: 'low', note: 'sin observaciones' })).body));
    // Errores: un NIT repetido, un id ajeno, cuerpos inválidos y un archivo con tipo falso.
    const dup = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...input, display_name: 'otro' });
    expect(dup.status).toBe(422);
    outputs.push(JSON.stringify(dup.body));
    outputs.push(JSON.stringify((await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...input, tax_id: 'x', extra: 1 })).body));
    outputs.push(JSON.stringify((await bo(ctx, 'get', '/merchants/mc_noexiste0000000000')).body));
    const fake = await bo(ctx, 'post', `/merchants/${id}/kyc/documents`, 'op-kyc').field('kind', 'nit').attach('file', Buffer.from('MZ\x90 documento sintético de prueba'), { filename: 'nit.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(422);
    outputs.push(JSON.stringify(fake.body));

    const events = (await ctx.db.pool.query('SELECT envelope::text AS e FROM outbox_events')).rows.map((r) => r.e as string);
    const logs = ctx.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const centinela of centinelas) {
      expect({ centinela, enLogs: logs.includes(centinela) }).toEqual({ centinela, enLogs: false });
      expect({ centinela, enEventos: events.some((e) => e.includes(centinela)) }).toEqual({ centinela, enEventos: false });
      expect({ centinela, enErrores: outputs.some((o) => o.includes(centinela)) }).toEqual({ centinela, enErrores: false });
    }
    expect(logs).not.toMatch(/authorization|bearer op-/i);
    // El nombre de fantasía sí lo ve el comercio mismo, pero tampoco viaja en eventos ni logs.
    expect(events.some((e) => e.includes('CENTINELA-FANTASIA-600'))).toBe(false);
    expect(logs.includes('CENTINELA-FANTASIA-600')).toBe(false);
  });

  it('regresión: repetir con la misma Idempotency-Key una petición que falló devuelve el MISMO error (422), no un 2xx', async () => {
    const first = await createMerchant(ctx, 601);
    expect(first).toBeTruthy();
    const body = merchantInput(601); // mismo NIT que el comercio ya creado
    const key = uniqueKey();
    const a = await bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(body);
    const b = await bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(body);
    expect([a.status, b.status]).toEqual([422, 422]);
    expect(b.body.code).toBe(a.body.code);
    expect(b.headers['content-type']).toMatch(/problem\+json/);
  });
});
