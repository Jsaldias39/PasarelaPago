import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { JwtOperatorAuthenticator } from '../src/operators/jwt-operator-authenticator';
import { createTestContext, type TestContext } from './support/app';
import { merchantInput, pdf, KINDS, SHA } from './support/fixtures';
import { uniqueKey } from './support/http';
import { AUDIENCE, bearerOf, ISSUER, OTHER_PUBLIC_KEY_PEM, PUBLIC_KEY_PEM, sign, signWithOtherKey } from './support/operator-jwt';

const run = promisify(execFile);
const OPERATOR = { publicKeyPem: PUBLIC_KEY_PEM, issuer: ISSUER, audience: AUDIENCE };

describe('JwtOperatorAuthenticator (credencial de operador RS256 atada al modo)', () => {
  const NOW = 1_800_000_000_000;
  const auth = (mode: 'sandbox' | 'live' = 'sandbox') => new JwtOperatorAuthenticator(PUBLIC_KEY_PEM, ISSUER, AUDIENCE, mode, () => NOW);
  const at = (over: Parameters<typeof sign>[0] = {}) => bearerOf(sign({ nowSeconds: NOW / 1000, ...over }));

  it('correcto: una credencial válida devuelve su `sub` y sus roles', async () => {
    expect(await auth().authenticate(at({ claims: { roles: ['merchant_operator', 'kyc_reviewer'], sub: 'op_1' } }))).toEqual({ sub: 'op_1', roles: ['merchant_operator', 'kyc_reviewer'] });
    expect(await auth().authenticate(at({ claims: { aud: ['otro', AUDIENCE] } }))).not.toBeNull(); // `aud` puede ser una lista
    expect(await auth('live').authenticate(at({ claims: { mode: 'live' } }))).not.toBeNull();
  });

  it('límite: la tolerancia de reloj es de 30 s (exp vencido hace 29 s pasa, hace 30 s no; nbf/iat 29 s en el futuro pasan, 31 s no)', async () => {
    const s = NOW / 1000;
    expect(await auth().authenticate(at({ claims: { exp: s - 29 } }))).not.toBeNull();
    expect(await auth().authenticate(at({ claims: { exp: s - 30 } }))).toBeNull();
    expect(await auth().authenticate(at({ claims: { nbf: s + 29 } }))).not.toBeNull();
    expect(await auth().authenticate(at({ claims: { nbf: s + 31 } }))).toBeNull();
    expect(await auth().authenticate(at({ claims: { iat: s + 31 } }))).toBeNull();
    expect(await auth().authenticate(at({ claims: { sub: 'x'.repeat(100) } }))).not.toBeNull();
    expect(await auth().authenticate(at({ claims: { sub: 'x'.repeat(101) } }))).toBeNull();
    expect(await auth().authenticate(at({ claims: { roles: [] } }))).toEqual({ sub: 'operador_sandbox_01', roles: [] });
  });

  it.each([
    ['sin cabecera', undefined],
    ['esquema distinto de Bearer', `Basic ${sign()}`],
    ['no es un JWT', 'Bearer abc'],
    ['bearer en minúscula', `bearer ${sign()}`],
    ['espacio de más', `Bearer  ${sign()}`],
  ])('inválido: %s ⇒ null', async (_name, header) => {
    expect(await auth().authenticate(header)).toBeNull();
  });

  it.each([
    ['firmada con la clave de OTRO emisor', () => bearerOf(signWithOtherKey())],
    ['alg: none', () => { const [, p] = sign().split('.'); return `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.${'a'.repeat(10)}`; }],
    ['alg: HS256 (confusión de algoritmo)', () => bearerOf(sign({ header: { alg: 'HS256' } }))],
    ['emisor distinto', () => bearerOf(sign({ claims: { iss: 'otro' } }))],
    ['audiencia distinta', () => bearerOf(sign({ claims: { aud: 'pay-risk' } }))],
    ['CREDENCIAL DE OTRO MODO (live en un despliegue sandbox)', () => bearerOf(sign({ claims: { mode: 'live' } }))],
    ['sin claim de modo', () => bearerOf(sign({ omit: ['mode'] }))],
    ['modo inventado', () => bearerOf(sign({ claims: { mode: 'test' } }))],
    ['vencida', () => bearerOf(sign({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }))],
    ['sin exp', () => bearerOf(sign({ omit: ['exp'] }))],
    ['exp como texto', () => bearerOf(sign({ claims: { exp: '9999999999' } }))],
    ['sin sub', () => bearerOf(sign({ omit: ['sub'] }))],
    ['roles que no es lista', () => bearerOf(sign({ claims: { roles: 'merchant_operator' } }))],
    ['roles con un elemento que no es texto', () => bearerOf(sign({ claims: { roles: ['merchant_operator', 7] } }))],
    ['sin roles', () => bearerOf(sign({ omit: ['roles'] }))],
    ['cuerpo alterado después de firmar', () => { const [h, , s] = sign().split('.'); return `Bearer ${h}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'x', roles: ['legal_admin'], mode: 'sandbox', exp: 9_999_999_999 })).toString('base64url')}.${s}`; }],
  ])('inválido: %s ⇒ null (sin lanzar)', async (_name, build) => {
    expect(await new JwtOperatorAuthenticator(PUBLIC_KEY_PEM, ISSUER, AUDIENCE, 'sandbox').authenticate(build())).toBeNull();
  });

  it('inválido: el despliegue `live` rechaza la credencial de sandbox', async () => {
    expect(await auth('live').authenticate(at())).toBeNull();
  });

  it('una clave pública que no es RSA no construye el verificador', () => {
    expect(() => new JwtOperatorAuthenticator('no es una clave', ISSUER, AUDIENCE, 'sandbox')).toThrow();
  });
});

describe('alta del PRIMER comercio con una credencial de operador real (sin la siembra del arnés ni el [DOBLE])', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ operator: OPERATOR });
  });
  afterAll(async () => ctx.close());

  const call = (method: 'get' | 'post' | 'put', path: string, token?: string) => {
    const req = request(ctx.server)[method](path).set('x-service-id', 'pay-backoffice');
    return token ? req.set('authorization', bearerOf(token)) : req;
  };
  const as = (...roles: string[]) => sign({ claims: { roles } });

  it('camino completo con una credencial por rol (mínimo privilegio): alta → documentos → KYC → contrato → activación → tarifario → clave de API', async () => {
    const created = await call('post', '/merchants', as('merchant_operator')).set('idempotency-key', uniqueKey()).send(merchantInput(900));
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    for (const kind of KINDS) {
      const up = await call('post', `/merchants/${id}/kyc/documents`, as('kyc_reviewer')).field('kind', kind).attach('file', pdf(kind), { filename: `${kind}.pdf`, contentType: 'application/pdf' });
      expect({ kind, status: up.status }).toEqual({ kind, status: 201 });
    }
    expect((await call('put', `/merchants/${id}/kyc/review`, as('kyc_reviewer')).send({ decision: 'approved', risk_level: 'low' })).status).toBe(200);
    expect((await call('post', '/contract_versions', as('legal_admin')).send({ version: 1, text_sha256: SHA })).status).toBe(201);
    expect((await call('post', `/merchants/${id}/contract_acceptances`, as('merchant_operator')).send({ version: 1, accepted_by_ref: 'representante-sintetico-900' })).status).toBe(201);
    const activated = await call('post', `/merchants/${id}/activate`, as('merchant_operator'));
    expect([activated.status, activated.body.status]).toEqual([200, 'active']);
    expect((await call('post', `/merchants/${id}/fee_schedules`, as('pricing_admin')).send({ channels: [{ channel: 'qr', percent: '3' }] })).status).toBe(201);
    // La clave de API que sale de ahí es la que el borde aprende: se crea por la ruta pública con el modo de la clave.
    const key = await request(ctx.server).post('/api_keys').set('x-service-id', 'pay-edge').set('x-merchant-id', id).set('x-pay-mode', 'test').set('idempotency-key', uniqueKey()).send({ mode: 'test' });
    expect(key.status).toBe(201);
    expect(key.body.secret).toMatch(/^sk_test_/);
    // Quién actuó sale de la credencial, no del cuerpo.
    const row = await ctx.db.pool.query('SELECT DISTINCT uploaded_by FROM kyc_documents WHERE merchant_id = $1', [id]);
    expect(row.rows).toEqual([{ uploaded_by: 'operador_sandbox_01' }]);
  });

  it('negativa: SIN credencial ⇒ 401 y no se crea nada', async () => {
    const before = (await ctx.db.pool.query('SELECT count(*)::int AS n FROM merchants')).rows[0].n;
    const res = await call('post', '/merchants').set('idempotency-key', uniqueKey()).send(merchantInput(901));
    expect(res.status).toBe(401);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM merchants')).rows[0].n).toBe(before);
  });

  it('negativa: ROL INSUFICIENTE ⇒ 403 (aprobar KYC con rol de ventas, publicar tarifa con rol de KYC, crear con credencial sin roles)', async () => {
    const created = await call('post', '/merchants', as('merchant_operator')).set('idempotency-key', uniqueKey()).send(merchantInput(902));
    const id = created.body.id as string;
    expect((await call('post', '/merchants').set('authorization', bearerOf(as('kyc_reviewer'))).set('idempotency-key', uniqueKey()).send(merchantInput(903))).status).toBe(403);
    expect((await call('put', `/merchants/${id}/kyc/review`, as('merchant_operator')).send({ decision: 'approved', risk_level: 'low' })).status).toBe(403);
    expect((await call('post', `/merchants/${id}/fee_schedules`, as('kyc_reviewer')).send({ channels: [{ channel: 'qr', percent: '3' }] })).status).toBe(403);
    expect((await call('post', '/contract_versions', as()).send({ version: 1, text_sha256: SHA })).status).toBe(403);
  });

  it('negativa: CREDENCIAL DE OTRO MODO (emitida para live) en un despliegue sandbox ⇒ 401; y la de sandbox en un despliegue live ⇒ 401', async () => {
    const live = sign({ claims: { mode: 'live', roles: ['merchant_operator'] } });
    expect((await call('post', '/merchants', live).set('idempotency-key', uniqueKey()).send(merchantInput(904))).status).toBe(401);
    const liveCtx = await createTestContext({ operator: OPERATOR, payMode: 'live' });
    try {
      const res = await request(liveCtx.server).post('/merchants').set('x-service-id', 'pay-backoffice').set('authorization', bearerOf(sign())).set('idempotency-key', uniqueKey()).send(merchantInput(905));
      expect(res.status).toBe(401);
      const ok = await request(liveCtx.server).post('/merchants').set('x-service-id', 'pay-backoffice').set('authorization', bearerOf(live)).set('idempotency-key', uniqueKey()).send(merchantInput(906));
      expect(ok.status).toBe(201); // la credencial de live sí sirve en live
    } finally {
      await liveCtx.close();
    }
  });

  it('negativa: firmada por OTRO emisor, vencida, o llamando por un servicio que no es pay-backoffice ⇒ rechazada', async () => {
    expect((await call('post', '/merchants', signWithOtherKey()).set('idempotency-key', uniqueKey()).send(merchantInput(907))).status).toBe(401);
    expect((await call('post', '/merchants', sign({ claims: { exp: Math.floor(Date.now() / 1000) - 600 } })).set('idempotency-key', uniqueKey()).send(merchantInput(908))).status).toBe(401);
    const wrongService = await request(ctx.server).post('/merchants').set('x-service-id', 'pay-edge').set('authorization', bearerOf(sign())).set('idempotency-key', uniqueKey()).send(merchantInput(909));
    expect(wrongService.status).toBe(403);
  });

  it('con una clave pública DISTINTA configurada, la credencial de la primera ya no sirve (no hay clave por defecto que la acepte)', async () => {
    const other = await createTestContext({ operator: { ...OPERATOR, publicKeyPem: OTHER_PUBLIC_KEY_PEM } });
    try {
      const res = await request(other.server).post('/merchants').set('x-service-id', 'pay-backoffice').set('authorization', bearerOf(sign())).set('idempotency-key', uniqueKey()).send(merchantInput(910));
      expect(res.status).toBe(401);
    } finally {
      await other.close();
    }
  });
});

describe('scripts/sandbox-operator-token.mjs: el secreto sintético se emite SOLO en sandbox y sirve contra el servicio', () => {
  const script = join(process.cwd(), 'scripts/sandbox-operator-token.mjs');
  const exec = (env: NodeJS.ProcessEnv, args: string[]) => run('node', [script, ...args], { env: { PATH: process.env.PATH, ...env } });

  it('correcto: con PAY_MODE=sandbox emite clave pública + credencial que el servicio acepta', async () => {
    const { stdout } = await exec({ PAY_MODE: 'sandbox' }, ['--roles', 'merchant_operator,legal_admin', '--issuer', 'pay-sandbox-identity', '--audience', 'pay-merchants', '--sub', 'operador_script_01']);
    const out = JSON.parse(stdout);
    expect(Object.keys(out).sort()).toEqual(['OPERATOR_TOKEN_AUDIENCE', 'OPERATOR_TOKEN_ISSUER', 'OPERATOR_TOKEN_PUBLIC_KEY', 'expires_at', 'roles', 'sub', 'token']);
    expect(stdout).not.toMatch(/PRIVATE KEY/);
    const ctx = await createTestContext({ operator: { publicKeyPem: out.OPERATOR_TOKEN_PUBLIC_KEY.replace(/\\n/g, '\n'), issuer: out.OPERATOR_TOKEN_ISSUER, audience: out.OPERATOR_TOKEN_AUDIENCE } });
    try {
      const res = await request(ctx.server).post('/merchants').set('x-service-id', 'pay-backoffice').set('authorization', bearerOf(out.token)).set('idempotency-key', uniqueKey()).send(merchantInput(920));
      expect(res.status).toBe(201);
      const forbidden = await request(ctx.server).put('/merchants/mc_noexiste0000000000/kyc/review').set('x-service-id', 'pay-backoffice').set('authorization', bearerOf(out.token)).send({ decision: 'approved', risk_level: 'low' });
      expect(forbidden.status).toBe(403); // la credencial solo trae los roles pedidos
    } finally {
      await ctx.close();
    }
  });

  it.each([
    ['PAY_MODE=live', { PAY_MODE: 'live' }],
    ['sin PAY_MODE', {}],
    ['PAY_MODE inválido', { PAY_MODE: 'test' }],
  ])('inválido: %s ⇒ se niega (salida 2) y no imprime ninguna credencial', async (_name, env) => {
    await expect(exec(env, ['--roles', 'merchant_operator', '--issuer', 'i', '--audience', 'a'])).rejects.toMatchObject({ code: 2, stdout: '' });
  });

  it.each([
    [['--issuer', 'i', '--audience', 'a']],
    [['--roles', '', '--issuer', 'i', '--audience', 'a']],
    [['--roles', 'x', '--audience', 'a']],
    [['--roles', 'x', '--issuer', 'i']],
    [['--roles', 'x', '--issuer', 'i', '--audience', 'a', '--ttl-seconds', '0']],
    [['--roles', 'x', '--issuer', 'i', '--audience', 'a', '--ttl-seconds', '86401']],
  ])('límite: argumentos inválidos %j ⇒ salida 2 (no hay emisor, audiencia ni roles por defecto)', async (args) => {
    await expect(exec({ PAY_MODE: 'sandbox' }, args)).rejects.toMatchObject({ code: 2, stdout: '' });
  });
});
