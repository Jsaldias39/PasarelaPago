import { generateApiKey } from '@pay/api-key';
import { startEdge, type EdgeHarness } from './harness';

/**
 * P1.H2.M4 — matriz de autorización NEGATIVA del borde. Todo corre contra Postgres y Redis reales; los servicios dueños son
 * [DOBLE] que aíslan por comercio como el real. Lo que NO se prueba acá: la revocación por NATS (replica.spec.ts).
 */
const PI = 'pi_abcdefghij12';
const bearer = (token: string) => `Bearer ${token}`;
const seen = (h: EdgeHarness) => Object.values(h.doubles).reduce((n, d) => n + d.requests.length, 0);
const reset = (h: EdgeHarness) => Object.values(h.doubles).forEach((d) => (d.requests.length = 0));

describe('[DOBLE] autorización del borde — claves y modos', () => {
  let h: EdgeHarness;
  beforeAll(async () => {
    h = await startEdge();
  });
  afterAll(async () => h.stop());
  afterEach(() => reset(h));
  const balance_ = (path: string) => h.http().get(path);
  const balance = (auth?: string) => {
    const r = h.http().get('/v1/balance');
    return auth === undefined ? r : r.set('Authorization', auth);
  };

  it('sin Authorization: 401 unauthorized con WWW-Authenticate, problem+json válido contra el contrato y nada llega a los servicios', async () => {
    const res = await balance();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'unauthorized', status: 401 });
    h.contract.assertResponse({ method: 'GET', path: '/balance', status: 401, body: res.body });
    expect(seen(h)).toBe(0);
  });

  it('el `instance` del error NO repite segmentos de la URL que parezcan datos del cliente (número de tarjeta, correo)', async () => {
    for (const path of ['/v1/4111111111111111', '/v1/ana@correo.com/x', '/v1/balance?email=ana@correo.com']) {
      const res = await balance_(path);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toMatch(/4111|ana@|correo/);
    }
    expect((await balance_('/v1/4111111111111111')).body.instance).toBe('/v1/:x');
  });

  it.each([
    ['esquema Basic', 'Basic c2tfdGVzdF94Onk='],
    ['Bearer vacío', 'Bearer '],
    ['Bearer con dos tokens', 'Bearer a b'],
    ['token sin formato', 'Bearer hola'],
    ['prefijo sin cuerpo', 'Bearer sk_test_'],
    ['modo inexistente', `Bearer ${generateApiKey('test').token.replace('sk_test_', 'sk_prod_')}`],
    ['token enorme (10 KB)', `Bearer ${'a'.repeat(10_000)}`],
  ])('autorización mal formada (%s): 401 y nada llega a los servicios', async (_name, auth) => {
    const res = await balance(auth);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(seen(h)).toBe(0);
  });

  it('una clave desconocida y una con el secreto equivocado dan EXACTAMENTE la misma respuesta (no se filtra qué claves existen)', async () => {
    const real = await h.seedKey({ mode: 'test' });
    const tampered = `${real.token.slice(0, -1)}${real.token.endsWith('a') ? 'b' : 'a'}`;
    const unknown = generateApiKey('test').token;
    const [wrongSecret, notFound] = [await balance(bearer(tampered)), await balance(bearer(unknown))];
    expect(wrongSecret.status).toBe(401);
    expect(notFound.status).toBe(401);
    const { request_id: idA, ...bodyA } = wrongSecret.body;
    const { request_id: idB, ...bodyB } = notFound.body;
    expect(idA).not.toBe(idB); // lo único distinto es el identificador de correlación
    expect(bodyA).toEqual(bodyB);
    expect(wrongSecret.headers['www-authenticate']).toBe(notFound.headers['www-authenticate']);
  });

  it('una clave revocada (revoked_at ya vencido) da 401, igual que una desconocida; una revocación FUTURA todavía sirve', async () => {
    const revoked = await h.seedKey({ revokedAtSql: "now() - interval '1 second'" });
    const scheduled = await h.seedKey({ revokedAtSql: "now() + interval '1 hour'" });
    const res = await balance(bearer(revoked.token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect((await balance(bearer(scheduled.token))).status).toBe(200);
  });

  it('una clave sin hash replicado todavía (solo llegó la revocación) NO autentica', async () => {
    const key = generateApiKey('test');
    await h.db.pool.query(`INSERT INTO api_key_replica (key_id, merchant_id, mode, key_hash, revoked_at, last_event_id) VALUES ($1, 'mc_sinhash', 'test', NULL, NULL, 'seed')`, [key.keyId]);
    expect((await balance(bearer(key.token))).status).toBe(401);
  });

  it('D-27/D-28: reescribir el prefijo del token (sk_test_ → sk_live_) para escalar de modo da 401', async () => {
    const test = await h.seedKey({ mode: 'test' });
    const forged = test.token.replace(/^sk_test_/, 'sk_live_');
    expect(forged).not.toBe(test.token);
    expect((await balance(bearer(forged))).status).toBe(401);
    expect(seen(h)).toBe(0);
  });

  it('una clave live en el borde sandbox da 401 (y la prueba reenviada nunca lleva modo live)', async () => {
    const live = await h.seedKey({ mode: 'live' });
    const res = await balance(bearer(live.token));
    expect(res.status).toBe(401);
    expect(seen(h)).toBe(0);
  });

  it('un comercio suspendido o cerrado da 403 merchant_suspended aunque su clave sea válida; reactivarlo lo habilita', async () => {
    const k = await h.seedKey();
    for (const status of ['suspended', 'closed'] as const) {
      await h.setMerchantStatus(k.merchantId, status);
      const res = await balance(bearer(k.token));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'merchant_suspended', status: 403 });
      // GET /balance no declara 403 (PROPUESTA 5): se valida contra la operación que sí lo declara.
      h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 403, body: res.body });
    }
    expect(seen(h)).toBe(0);
    await h.setMerchantStatus(k.merchantId, 'active');
    expect((await balance(bearer(k.token))).status).toBe(200);
  });
});

describe('[DOBLE] autorización del borde — identidad, aislamiento entre comercios y cabeceras falsificadas', () => {
  let h: EdgeHarness;
  beforeAll(async () => {
    h = await startEdge();
  });
  afterAll(async () => h.stop());
  afterEach(() => reset(h));

  it('el recurso de OTRO comercio da 404 resource_not_found (no 403: no se confirma que existe) y el dueño lo ve', async () => {
    const owner = await h.seedKey();
    const other = await h.seedKey();
    h.doubles['pay-payments'].own(owner.merchantId, PI);

    const intruder = await h.http().get(`/v1/payment_intents/${PI}`).set('Authorization', bearer(other.token));
    expect(intruder.status).toBe(404);
    expect(intruder.body.code).toBe('resource_not_found');
    expect(h.doubles['pay-payments'].requests[0].headers['x-merchant-id']).toBe(other.merchantId);

    const mutation = await h.http().post(`/v1/payment_intents/${PI}/cancel`).set('Authorization', bearer(other.token)).set('Idempotency-Key', 'clave-de-idempotencia-0001');
    expect(mutation.status).toBe(404);

    expect((await h.http().get(`/v1/payment_intents/${PI}`).set('Authorization', bearer(owner.token))).status).toBe(200);
  });

  it('GET /refunds/{id}: el reembolso de OTRO comercio da 404 resource_not_found y el dueño lo ve (200)', async () => {
    const owner = await h.seedKey();
    const other = await h.seedKey();
    h.doubles['pay-payments'].own(owner.merchantId, 're_abcdefghij12');
    const intruder = await h.http().get('/v1/refunds/re_abcdefghij12').set('Authorization', bearer(other.token));
    expect(intruder.status).toBe(404);
    expect(intruder.body.code).toBe('resource_not_found');
    const ok = await h.http().get('/v1/refunds/re_abcdefghij12').set('Authorization', bearer(owner.token));
    expect(ok.status).toBe(200);
    expect(h.contract.validateResponse({ method: 'GET', path: '/refunds/re_abcdefghij12', status: 200, body: ok.body })).toEqual([]);
    expect((await h.http().get('/v1/refunds/re_abcdefghij12')).status).toBe(401);
  });

  it('X-Merchant-Id, X-Service-Id y X-Pay-Mode del cliente no llegan: el servicio recibe la identidad que el borde autenticó', async () => {
    const victim = await h.seedKey();
    const attacker = await h.seedKey();
    h.doubles['pay-payments'].own(victim.merchantId, PI);

    const res = await h
      .http()
      .get(`/v1/payment_intents/${PI}`)
      .set('Authorization', bearer(attacker.token))
      .set('X-Merchant-Id', victim.merchantId)
      .set('X-Service-Id', 'pay-ledger')
      .set('X-Pay-Mode', 'live');
    expect(res.status).toBe(404); // el atacante sigue siendo el atacante
    const forwarded = h.doubles['pay-payments'].requests[0].headers;
    expect(forwarded['x-merchant-id']).toBe(attacker.merchantId);
    expect(forwarded['x-service-id']).toBe('pay-edge');
    expect(forwarded['x-pay-mode']).toBe('test');
    expect(forwarded.authorization).toBeUndefined();
  });

  it('D-28: el X-Pay-Mode reenviado es EXACTAMENTE el modo del registro de la clave (test|live), nunca «sandbox» ni lo que diga el token', async () => {
    const k = await h.seedKey({ mode: 'test' });
    h.doubles['pay-merchants'].requests.length = 0;
    await h.http().get('/v1/api_keys').set('Authorization', `Bearer ${k.token}`);
    const registry = await h.db.pool.query('SELECT mode FROM api_key_replica WHERE key_id = $1', [k.keyId]);
    const forwarded = h.doubles['pay-merchants'].requests[0].headers['x-pay-mode'];
    expect(forwarded).toBe(registry.rows[0].mode);
    expect(forwarded).toMatch(/^(test|live)$/);
    expect(forwarded).not.toBe('sandbox');
  });

  it('no se puede elegir comercio por la consulta: ?merchant_id= es un parámetro desconocido (422) y no llega al servicio', async () => {
    const k = await h.seedKey();
    const res = await h.http().get('/v1/payment_intents?merchant_id=mc_otro').set('Authorization', bearer(k.token));
    expect(res.status).toBe(422);
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
  });

  it('un comercio no puede usar la clave de otro aunque conozca el key_id: el secreto manda', async () => {
    const a = await h.seedKey();
    const b = await h.seedKey();
    const frankenstein = `${a.token.slice(0, a.token.lastIndexOf('_'))}_${b.token.slice(b.token.lastIndexOf('_') + 1)}`;
    expect((await h.http().get('/v1/balance').set('Authorization', bearer(frankenstein))).status).toBe(401);
  });
});

describe('[DOBLE] autorización del borde — modo live', () => {
  let h: EdgeHarness;
  beforeAll(async () => {
    h = await startEdge({ env: { PAY_MODE: 'live' } });
  });
  afterAll(async () => h.stop());

  it('el borde live rechaza claves test (401) y acepta claves live, reenviando X-Pay-Mode: live y sin marcar la respuesta como sandbox', async () => {
    const test = await h.seedKey({ mode: 'test' });
    const live = await h.seedKey({ mode: 'live' });
    expect((await h.http().get('/v1/balance').set('Authorization', bearer(test.token))).status).toBe(401);
    expect(h.doubles['pay-ledger'].requests).toHaveLength(0);

    const ok = await h.http().get('/v1/balance').set('Authorization', bearer(live.token));
    expect(ok.status).toBe(200);
    expect(h.doubles['pay-ledger'].requests[0].headers['x-pay-mode']).toBe('live');
    const registry = await h.db.pool.query('SELECT mode FROM api_key_replica WHERE key_id = $1', [live.keyId]);
    expect(h.doubles['pay-ledger'].requests[0].headers['x-pay-mode']).toBe(registry.rows[0].mode);
    expect(ok.headers['x-pay-mode']).toBeUndefined();
  });
});

describe('[DOBLE] autorización del borde — frenos de abuso', () => {
  it('quien falla la autenticación más veces que el tope queda frenado con 429 + Retry-After, aun con una clave válida', async () => {
    const h = await startEdge({ env: { RATE_LIMIT_AUTH_FAILURES_PER_WINDOW: '3' } });
    try {
      const good = await h.seedKey();
      for (let i = 0; i < 3; i += 1) expect((await h.http().get('/v1/balance').set('Authorization', bearer(generateApiKey('test').token))).status).toBe(401);
      const blocked = await h.http().get('/v1/balance').set('Authorization', bearer(good.token));
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('rate_limited');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(h.doubles['pay-ledger'].requests).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('el éxito no suma fallos: 20 peticiones válidas seguidas no activan el freno', async () => {
    const h = await startEdge({ env: { RATE_LIMIT_AUTH_FAILURES_PER_WINDOW: '3' } });
    try {
      const good = await h.seedKey();
      for (let i = 0; i < 20; i += 1) expect((await h.http().get('/v1/balance').set('Authorization', bearer(good.token))).status).toBe(200);
    } finally {
      await h.stop();
    }
  });

  it('el límite por clave corta a esa clave (429) sin afectar a otro comercio', async () => {
    const h = await startEdge({ env: { RATE_LIMIT_KEY_PER_WINDOW: '3' } });
    try {
      const a = await h.seedKey();
      const b = await h.seedKey();
      for (let i = 0; i < 3; i += 1) expect((await h.http().get('/v1/balance').set('Authorization', bearer(a.token))).status).toBe(200);
      const limited = await h.http().get('/v1/balance').set('Authorization', bearer(a.token));
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      // GET /balance no declara 429 (PROPUESTA 5): se valida contra la operación que sí lo declara.
      h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 429, body: limited.body });
      expect((await h.http().get('/v1/balance').set('Authorization', bearer(b.token))).status).toBe(200);
    } finally {
      await h.stop();
    }
  });

  it('el límite por IP corta antes de autenticar: sin credenciales también da 429 al pasar el tope', async () => {
    const h = await startEdge({ env: { RATE_LIMIT_IP_PER_WINDOW: '3' } });
    try {
      for (let i = 0; i < 3; i += 1) expect((await h.http().get('/v1/balance')).status).toBe(401);
      expect((await h.http().get('/v1/balance')).status).toBe(429);
    } finally {
      await h.stop();
    }
  });

  it('un cuerpo enorme de alguien sin autenticar se rechaza con 401 sin leerlo ni reenviarlo', async () => {
    const h = await startEdge();
    try {
      const res = await h.http().post('/v1/payment_intents').set('Idempotency-Key', 'clave-de-idempotencia-0001').set('Content-Type', 'application/json').send(`{"p":"${'a'.repeat(3_000_000)}"}`);
      expect(res.status).toBe(401);
      expect(h.doubles['pay-payments'].requests).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });
});
