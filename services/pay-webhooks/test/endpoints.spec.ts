import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/** P1.H3.M2 (API de endpoints), M6 (422 al registrar destinos peligrosos) y la matriz de autorización negativa del servicio. */
const GOOD = { url: 'https://hooks.comercio.example/pay', enabled_events: ['payment_intent.succeeded', 'refund.succeeded'] };

describe('[DOBLE de DNS] API de webhook_endpoints', () => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks({
      resolverTable: { 'privado.comercio.example': ['10.0.0.9'], 'metadatos.comercio.example': ['169.254.169.254'], 'loopback.comercio.example': ['127.0.0.1'], 'mixto.comercio.example': ['93.184.216.34', '192.168.1.5'] },
    });
  });
  afterAll(async () => h.stop());

  describe('nivel CORRECTO', () => {
    it('crea un endpoint v1: 201 con el secreto whsec_ UNA vez, válido contra el contrato', async () => {
      const merchant = newMerchantId();
      const res = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ object: 'webhook_endpoint', url: GOOD.url, enabled_events: GOOD.enabled_events, status: 'enabled', disabled_reason: null });
      expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32,}$/);
      expect(res.headers['cache-control']).toBe('no-store');
      h.contract.assertResponse({ method: 'POST', path: '/webhook_endpoints', status: 201, body: res.body });

      const listed = await h.as(merchant).get('/webhook_endpoints');
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain('whsec_');
      expect(listed.body.data).toHaveLength(1);
      h.contract.assertResponse({ method: 'GET', path: '/webhook_endpoints', status: 200, body: listed.body });
    });

    it('crea un endpoint v1a: el secreto que se muestra es la clave PÚBLICA whpk_ (la secreta whsk_ nunca sale)', async () => {
      const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ ...GOOD, signature_scheme: 'v1a' });
      expect(res.status).toBe(201);
      expect(res.body.secret).toMatch(/^whpk_/);
      expect(JSON.stringify(res.body)).not.toContain('whsk_');
    });

    it('rota el secreto: 200 con un secreto NUEVO y el listado no cambia', async () => {
      const merchant = newMerchantId();
      const created = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
      const rotated = await h.as(merchant).post(`/webhook_endpoints/${created.body.id}/rotate_secret`).set('Idempotency-Key', newKey());
      expect(rotated.status).toBe(200);
      expect(rotated.body.secret).toMatch(/^whsec_/);
      expect(rotated.body.secret).not.toBe(created.body.secret);
      expect(rotated.body.id).toBe(created.body.id);
      h.contract.assertResponse({ method: 'POST', path: `/webhook_endpoints/${created.body.id}/rotate_secret`, status: 200, body: rotated.body });
      const versions = await h.db.pool.query('SELECT version, expires_at FROM webhook_secrets WHERE endpoint_id = $1 ORDER BY version', [created.body.id]);
      expect(versions.rows.map((r) => r.version)).toEqual([1, 2]);
      expect(versions.rows[0].expires_at).not.toBeNull(); // la vieja vence al terminar la gracia
      expect(versions.rows[1].expires_at).toBeNull();
    });

    it('elimina el endpoint: 204 y después deja de existir (404)', async () => {
      const merchant = newMerchantId();
      const created = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
      const removed = await h.as(merchant).delete(`/webhook_endpoints/${created.body.id}`);
      expect(removed.status).toBe(204);
      expect((await h.as(merchant).delete(`/webhook_endpoints/${created.body.id}`)).status).toBe(404);
      expect((await h.as(merchant).get('/webhook_endpoints')).body.data).toHaveLength(0);
    });

    it('pagina de más nuevo a más viejo con cursor opaco, sin repetir ni saltar', async () => {
      const merchant = newMerchantId();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD)).body.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const res = await h.as(merchant).get(`/webhook_endpoints?limit=2${cursor ? `&starting_after=${cursor}` : ''}`);
        seen.push(...res.body.data.map((e: { id: string }) => e.id));
        if (!res.body.has_more) break;
        cursor = res.body.next_cursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...ids].sort());
    });
  });

  describe('idempotencia (REQ-P1-2 en el servicio dueño)', () => {
    it('repetir el alta con la misma Idempotency-Key devuelve LO MISMO (incluido el secreto) y crea un solo endpoint', async () => {
      const merchant = newMerchantId();
      const key = newKey();
      const first = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
      const second = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
      expect(second.status).toBe(201);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect((await h.as(merchant).get('/webhook_endpoints')).body.data).toHaveLength(1);
    });

    it('la misma clave con OTRO cuerpo es 422 idempotency_key_reused', async () => {
      const merchant = newMerchantId();
      const key = newKey();
      await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
      const other = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send({ ...GOOD, enabled_events: ['payout.paid'] });
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('idempotency_key_reused');
    });

    it('repetir la rotación con la misma clave NO rota otra vez: mismo secreto, una sola versión nueva', async () => {
      const merchant = newMerchantId();
      const created = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
      const key = newKey();
      const a = await h.as(merchant).post(`/webhook_endpoints/${created.body.id}/rotate_secret`).set('Idempotency-Key', key);
      const b = await h.as(merchant).post(`/webhook_endpoints/${created.body.id}/rotate_secret`).set('Idempotency-Key', key);
      expect(b.body.secret).toBe(a.body.secret);
      const versions = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_secrets WHERE endpoint_id = $1', [created.body.id]);
      expect(versions.rows[0].n).toBe(2);
    });

    it('10 altas simultáneas con la misma clave dejan UN endpoint (ninguna escribe dos veces)', async () => {
      const merchant = newMerchantId();
      const key = newKey();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD)));
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      const rows = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1', [merchant]);
      expect(rows.rows[0].n).toBe(1);
    });

    it('sin Idempotency-Key una mutación da 400 idempotency_key_required', async () => {
      const res = await h.as(newMerchantId()).post('/webhook_endpoints').send(GOOD);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('idempotency_key_required');
    });
  });

  describe('M6 — destinos peligrosos al registrar: 422 con el campo y NADA queda guardado', () => {
    it.each([
      ['http plano', 'http://hooks.comercio.example/pay', 'https_required'],
      ['127.0.0.1', 'https://127.0.0.1/pay', 'private_address'],
      ['metadatos de nube', 'https://169.254.169.254/latest/meta-data/', 'private_address'],
      ['10.x', 'https://10.0.0.5/pay', 'private_address'],
      ['IPv6 loopback', 'https://[::1]/pay', 'private_address'],
      ['servicio interno', 'https://pay-ledger/pay', 'internal_name'],
      ['localhost', 'https://localhost/pay', 'internal_name'],
      ['nombre que resuelve a una IP privada', 'https://privado.comercio.example/pay', 'private_address'],
      ['nombre que resuelve a metadatos', 'https://metadatos.comercio.example/pay', 'private_address'],
      ['nombre que resuelve a loopback', 'https://loopback.comercio.example/pay', 'private_address'],
      ['nombre con UNA dirección privada entre varias', 'https://mixto.comercio.example/pay', 'private_address'],
      ['con credenciales', 'https://u:p@hooks.comercio.example/pay', 'credentials_in_url'],
      ['puerto 5432', 'https://hooks.comercio.example:5432/pay', 'port_not_allowed'],
      ['no resuelve', 'https://no-existe.comercio.example/pay', 'unresolvable'],
      ['basura', 'esto no es una url', 'invalid_url'],
    ])('%s', async (_name, url, code) => {
      const merchant = newMerchantId();
      const res = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ ...GOOD, url });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors).toEqual([{ field: 'url', code }]);
      h.contract.assertResponse({ method: 'POST', path: '/webhook_endpoints', status: 422, body: res.body });
      expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0|169\.254|192\.168|127\.0/);
      const rows = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1', [merchant]);
      expect(rows.rows[0].n).toBe(0);
    });
  });

  describe('nivel INVÁLIDO — validación del cuerpo', () => {
    it.each([
      ['sin url', { enabled_events: ['payout.paid'] }, 'url'],
      ['sin eventos', { url: GOOD.url }, 'enabled_events'],
      ['eventos vacíos', { ...GOOD, enabled_events: [] }, 'enabled_events'],
      ['evento con formato inválido', { ...GOOD, enabled_events: ['PAGO'] }, 'enabled_events'],
      ['evento INTERNO (ledger.*)', { ...GOOD, enabled_events: ['ledger.transfer.posted'] }, 'enabled_events'],
      ['evento inexistente', { ...GOOD, enabled_events: ['payment_intent.teleported'] }, 'enabled_events'],
      ['esquema desconocido', { ...GOOD, signature_scheme: 'v2' }, 'signature_scheme'],
      ['descripción demasiado larga', { ...GOOD, description: 'x'.repeat(201) }, 'description'],
      ['asignación masiva: merchant_id', { ...GOOD, merchant_id: 'mc_ajeno0000001' }, 'merchant_id'],
      ['asignación masiva: status', { ...GOOD, status: 'enabled' }, 'status'],
      ['asignación masiva: secret', { ...GOOD, secret: 'whsec_elegido' }, 'secret'],
      ['url no es texto', { ...GOOD, url: 42 }, 'url'],
    ])('%s ⇒ 422 en el campo %s', async (_name, body, field) => {
      const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(body);
      expect(res.status).toBe(422);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    });

    it('acepta el comodín * y los eventos duplicados se normalizan', async () => {
      const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ ...GOOD, enabled_events: ['*', '*'] });
      expect(res.status).toBe(201);
      expect(res.body.enabled_events).toEqual(['*']);
    });

    it('el JSON mal formado es 4xx RFC 9457, no 500', async () => {
      const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', newKey()).set('Content-Type', 'application/json').send('{"url":');
      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('tope de endpoints por comercio: el siguiente da 422 limit_reached', async () => {
      const limited = await startWebhooks({ env: { WEBHOOKS_MAX_ENDPOINTS: '2' } });
      try {
        const merchant = newMerchantId();
        for (let i = 0; i < 2; i += 1) expect((await limited.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD)).status).toBe(201);
        const res = await limited.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
        expect(res.status).toBe(422);
        expect(res.body.errors).toEqual([{ field: 'endpoint', code: 'limit_reached' }]);
      } finally {
        await limited.stop();
      }
    });
  });

  describe('autorización negativa (regla 80.2.3)', () => {
    it('sin identidad de servicio: 403', async () => {
      const res = await h.http().get('/webhook_endpoints').set('X-Merchant-Id', newMerchantId());
      expect(res.status).toBe(403);
    });

    it.each(['pay-payments', 'pay-ledger', 'pay-vault', 'pay-webhooks'])('un servicio que no es pay-edge (%s): 403', async (service) => {
      const res = await h.http().get('/webhook_endpoints').set('X-Service-Id', service).set('X-Merchant-Id', newMerchantId());
      expect(res.status).toBe(403);
    });

    it.each([undefined, 'mc_corto', "mc_x'; DROP TABLE webhook_endpoints;--", 'otra-cosa'])('pay-edge sin comercio válido (%p): 401', async (merchant) => {
      let req = h.http().get('/webhook_endpoints').set('X-Service-Id', 'pay-edge');
      if (merchant !== undefined) req = req.set('X-Merchant-Id', merchant);
      expect((await req).status).toBe(401);
    });

    it('OTRO comercio no ve, no rota y no borra un endpoint ajeno: 404 idéntico a uno inexistente', async () => {
      const owner = newMerchantId();
      const intruder = newMerchantId();
      const created = await h.as(owner).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(GOOD);
      const id = created.body.id;

      expect((await h.as(intruder).get('/webhook_endpoints')).body.data).toHaveLength(0);
      const rotate = await h.as(intruder).post(`/webhook_endpoints/${id}/rotate_secret`).set('Idempotency-Key', newKey());
      const remove = await h.as(intruder).delete(`/webhook_endpoints/${id}`);
      const missing = await h.as(intruder).delete('/webhook_endpoints/we_noexiste0000');
      expect(rotate.status).toBe(404);
      expect(remove.status).toBe(404);
      expect(remove.body.code).toBe(missing.body.code);
      h.contract.assertResponse({ method: 'DELETE', path: `/webhook_endpoints/${id}`, status: 404, body: remove.body });

      // y el dueño sigue intacto
      const rows = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_secrets WHERE endpoint_id = $1', [id]);
      expect(rows.rows[0].n).toBe(1);
      expect((await h.as(owner).get('/webhook_endpoints')).body.data).toHaveLength(1);
    });

    it('un id con formato inválido en la ruta es 404', async () => {
      const res = await h.as(newMerchantId()).delete("/webhook_endpoints/we_';DROP");
      expect(res.status).toBe(404);
    });

    it('un cursor inválido es 422, no 500', async () => {
      const res = await h.as(newMerchantId()).get('/webhook_endpoints?starting_after=bm8tZXMtdW4taWQ');
      expect(res.status).toBe(422);
    });
  });

  describe('secretos: nunca en claro', () => {
    it('ni en webhook_secrets ni en idempotency_keys ni en los logs de la fila aparece el secreto', async () => {
      const merchant = newMerchantId();
      const key = newKey();
      const created = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
      const secret: string = created.body.secret;
      const stored = await h.db.pool.query('SELECT sealed_secret, public_key FROM webhook_secrets WHERE endpoint_id = $1', [created.body.id]);
      expect(JSON.stringify(stored.rows)).not.toContain(secret.slice(6));
      expect(stored.rows[0].sealed_secret).toMatch(/^v1\./);
      const idem = await h.db.pool.query('SELECT response_body FROM idempotency_keys WHERE scope = $1 AND key = $2', [merchant, key]);
      expect(JSON.stringify(idem.rows)).not.toContain(secret.slice(6));
    });
  });
});
