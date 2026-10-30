import request from 'supertest';
import { createTestContext, PLATFORM_MERCHANT, type TestContext } from './support/app';
import { createMandate, eventsOf, mandateBody, newMerchant, pub, rows, setMerchantStatus, uniqueKey, verifiedMandate } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await setMerchantStatus(ctx, PLATFORM_MERCHANT, 'active');
});
afterAll(async () => ctx.close());

const setup = async () => {
  const payer = newMerchant();
  const beneficiary = newMerchant();
  await setMerchantStatus(ctx, payer, 'active');
  await setMerchantStatus(ctx, beneficiary, 'active');
  return { payer, beneficiary };
};

describe('POST /mandates (REQ-P5-6, P5.H3.M2)', () => {
  it('crea el mandato, cumple el contrato público y publica mandate.created (válido contra el AsyncAPI, sin datos personales)', async () => {
    const { payer, beneficiary } = await setup();
    const res = await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: 123_456 }, { day_of_month: 20, start_date: '2026-04-01', end_date: '2026-12-31' }));
    const body = verifiedMandate(ctx.publicContract, 'post', '/mandates', res, 201);
    expect(body).toMatchObject({ object: 'mandate', status: 'active', kind: 'pay_obligation', beneficiary_merchant_id: beneficiary, amount_minor: 123_456, currency: 'BOB', next_run_on: '2026-04-20' });
    expect(body.schedule).toEqual({ frequency: 'monthly', day_of_month: 20, start_date: '2026-04-01', end_date: '2026-12-31' });
    const [event] = await eventsOf(ctx, 'mandate.created', body.id);
    expect(event.data).toEqual({
      mandate_id: body.id, merchant_id: payer, mode: 'test', status: 'active', kind: 'pay_obligation', beneficiary_merchant_id: beneficiary, amount_minor: 123_456, currency: 'BOB',
      frequency: 'monthly', day_of_month: 20, start_date: '2026-04-01', end_date: '2026-12-31',
    });
    expect(JSON.stringify(event)).not.toContain('Obligación'); // la descripción libre no sale por el bus
  });

  it('la primera fecha es la primera con ese día del mes en o después del inicio (cruza mes y año)', async () => {
    const { payer, beneficiary } = await setup();
    const a = await createMandate(ctx, payer, mandateBody(beneficiary, {}, { day_of_month: 5, start_date: '2026-12-20' }));
    expect(a.body.next_run_on).toBe('2027-01-05');
    const b = await createMandate(ctx, payer, mandateBody(beneficiary, {}, { day_of_month: 28, start_date: '2026-03-10' }));
    expect(b.body.next_run_on).toBe('2026-03-28');
  });

  describe('idempotencia', () => {
    it('repetir la misma petición devuelve 200 con el mismo mandato y no crea otro ni otro evento', async () => {
      const { payer, beneficiary } = await setup();
      const key = uniqueKey();
      const body = mandateBody(beneficiary);
      const first = await createMandate(ctx, payer, body, key);
      const second = await createMandate(ctx, payer, body, key);
      expect([first.status, second.status]).toEqual([201, 200]);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await rows(ctx, 'SELECT 1 FROM mandates WHERE merchant_id = $1', [payer])).toHaveLength(1);
      expect(await eventsOf(ctx, 'mandate.created', first.body.id)).toHaveLength(1);
    });

    it('la misma clave con otro cuerpo es 422 `idempotency_key_reused`; sin clave es 400', async () => {
      const { payer, beneficiary } = await setup();
      const key = uniqueKey();
      await createMandate(ctx, payer, mandateBody(beneficiary), key);
      const other = await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: 1 }), key);
      expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
      const missing = await pub(ctx, 'post', '/mandates', payer).send(mandateBody(beneficiary));
      expect([missing.status, missing.body.code]).toEqual([400, 'idempotency_key_required']);
    });

    it('repetir una petición que FALLÓ devuelve el mismo error, no un 2xx', async () => {
      const { payer } = await setup();
      const key = uniqueKey();
      const body = mandateBody(newMerchant()); // beneficiario desconocido
      const a = await createMandate(ctx, payer, body, key);
      const b = await createMandate(ctx, payer, body, key);
      expect([a.status, b.status]).toEqual([422, 422]);
      expect(b.headers['content-type']).toMatch(/problem\+json/);
    });

    it('5 llamadas simultáneas con la misma clave: un solo mandato', async () => {
      const { payer, beneficiary } = await setup();
      const key = uniqueKey();
      const results = await Promise.all(Array.from({ length: 5 }, () => createMandate(ctx, payer, mandateBody(beneficiary), key)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
      expect(await rows(ctx, 'SELECT 1 FROM mandates WHERE merchant_id = $1', [payer])).toHaveLength(1);
    });
  });

  describe('beneficiarios y reglas de negocio (Q-15: supuesto conservador)', () => {
    it('beneficiario desconocido, suspendido o cerrado ⇒ 422 con el motivo; a sí mismo ⇒ 422', async () => {
      const { payer, beneficiary } = await setup();
      const unknown = await createMandate(ctx, payer, mandateBody(newMerchant()));
      expect([unknown.status, unknown.body.errors]).toEqual([422, [{ field: 'beneficiary_merchant_id', code: 'unknown' }]]);
      for (const status of ['suspended', 'closed'] as const) {
        await setMerchantStatus(ctx, beneficiary, status);
        const res = await createMandate(ctx, payer, mandateBody(beneficiary));
        expect([res.status, res.body.errors]).toEqual([422, [{ field: 'beneficiary_merchant_id', code: 'not_active' }]]);
      }
      const self = await createMandate(ctx, payer, mandateBody(payer));
      expect(self.body.errors).toEqual([{ field: 'beneficiary_merchant_id', code: 'is_payer' }]);
    });

    it('un pagador suspendido ⇒ 403 `merchant_suspended`; cerrado ⇒ 403 `forbidden`; no se escribe nada', async () => {
      const { payer, beneficiary } = await setup();
      await setMerchantStatus(ctx, payer, 'suspended');
      const suspended = await createMandate(ctx, payer, mandateBody(beneficiary));
      expect([suspended.status, suspended.body.code]).toEqual([403, 'merchant_suspended']);
      await setMerchantStatus(ctx, payer, 'closed');
      expect((await createMandate(ctx, payer, mandateBody(beneficiary))).status).toBe(403);
      expect(await rows(ctx, 'SELECT 1 FROM mandates WHERE merchant_id = $1', [payer])).toHaveLength(0);
    });

    it('comisión (7.8): solo a AloVida; a otro comercio o sin comercio de plataforma configurado ⇒ 422', async () => {
      const { payer, beneficiary } = await setup();
      const ok = await createMandate(ctx, payer, mandateBody(PLATFORM_MERCHANT, { kind: 'pay_commission' }));
      expect(ok.status).toBe(201);
      const other = await createMandate(ctx, payer, mandateBody(beneficiary, { kind: 'pay_commission' }));
      expect([other.status, other.body.errors]).toEqual([422, [{ field: 'beneficiary_merchant_id', code: 'not_platform' }]]);
      const without = await createTestContext({ settings: { platformMerchantId: undefined } });
      try {
        await setMerchantStatus(without, payer, 'active');
        await setMerchantStatus(without, PLATFORM_MERCHANT, 'active');
        const res = await createMandate(without, payer, mandateBody(PLATFORM_MERCHANT, { kind: 'pay_commission' }));
        expect([res.status, res.body.errors]).toEqual([422, [{ field: 'kind', code: 'commission_not_supported' }]]);
      } finally {
        await without.close();
      }
    });

    it('el tope por mandato (si se configura) se aplica en el borde: igual al tope pasa, un centavo más no; sin tope configurado no hay tope', async () => {
      const capped = await createTestContext({ settings: { mandateMaxAmountMinor: 500_000 } });
      try {
        const payer = newMerchant();
        const beneficiary = newMerchant();
        await setMerchantStatus(capped, payer, 'active');
        await setMerchantStatus(capped, beneficiary, 'active');
        expect((await createMandate(capped, payer, mandateBody(beneficiary, { amount_minor: 500_000 }))).status).toBe(201);
        const over = await createMandate(capped, payer, mandateBody(beneficiary, { amount_minor: 500_001 }));
        expect([over.status, over.body.errors]).toEqual([422, [{ field: 'amount_minor', code: 'over_cap' }]]);
      } finally {
        await capped.close();
      }
      const { payer, beneficiary } = await setup();
      expect((await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: 9_007_199_254_740_991 }))).status).toBe(201);
    });
  });

  describe('calendario', () => {
    it.each([
      ['inicio en el pasado', { start_date: '2026-03-09' }, { field: 'schedule.start_date', code: 'in_the_past' }],
      ['fecha de inicio inexistente', { start_date: '2026-02-30' }, { field: 'schedule.start_date', code: 'format' }],
      ['fin antes del inicio', { start_date: '2026-04-01', end_date: '2026-03-31' }, { field: 'schedule.end_date', code: 'before_start' }],
      ['fin inexistente', { start_date: '2026-04-01', end_date: '2026-04-31' }, { field: 'schedule.end_date', code: 'format' }],
      ['ningún periodo cae entre inicio y fin', { start_date: '2026-04-16', end_date: '2026-04-30', day_of_month: 15 }, { field: 'schedule.end_date', code: 'no_periods' }],
    ])('%s ⇒ 422', async (_name, schedule, error) => {
      const { payer, beneficiary } = await setup();
      const res = await createMandate(ctx, payer, mandateBody(beneficiary, {}, schedule));
      expect([res.status, res.body.errors]).toEqual([422, [error]]);
    });

    it('límite: empezar HOY es válido (hora de La Paz); el día anterior ya no', async () => {
      const { payer, beneficiary } = await setup();
      ctx.clock.now = new Date('2026-03-11T03:59:00Z'); // en La Paz todavía es 10-mar
      expect((await createMandate(ctx, payer, mandateBody(beneficiary, {}, { start_date: '2026-03-10' }))).status).toBe(201);
      ctx.clock.now = new Date('2026-03-11T04:00:00Z'); // ya es 11-mar
      expect((await createMandate(ctx, payer, mandateBody(beneficiary, {}, { start_date: '2026-03-10' }))).status).toBe(422);
      ctx.clock.now = new Date('2026-03-10T18:00:00Z');
    });
  });

  it.each([
    ['moneda distinta de BOB', { currency: 'USD' }],
    ['importe 0', { amount_minor: 0 }],
    ['importe decimal', { amount_minor: 10.5 }],
    ['importe sobre el máximo seguro', { amount_minor: 9007199254740992 }],
    ['tipo inexistente', { kind: 'pay_tax' }],
    ['comercio beneficiario mal formado', { beneficiary_merchant_id: 'MC_1' }],
    ['descripción de 201 caracteres', { description: 'x'.repeat(201) }],
    ['campo de más (modo en el cuerpo)', { mode: 'live' }],
    ['frecuencia semanal', { schedule: { frequency: 'weekly', day_of_month: 1, start_date: '2026-04-01' } }],
    ['día 29', { schedule: { frequency: 'monthly', day_of_month: 29, start_date: '2026-04-01' } }],
    ['día 0', { schedule: { frequency: 'monthly', day_of_month: 0, start_date: '2026-04-01' } }],
    ['fecha con formato libre', { schedule: { frequency: 'monthly', day_of_month: 1, start_date: '1/4/2026' } }],
  ])('inválido: %s ⇒ 422 sin escribir nada', async (_name, override) => {
    const { payer, beneficiary } = await setup();
    const res = await createMandate(ctx, payer, mandateBody(beneficiary, override));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(await rows(ctx, 'SELECT 1 FROM mandates WHERE merchant_id = $1', [payer])).toHaveLength(0);
  });
});

describe('GET /mandates y DELETE /mandates/{id}', () => {
  it('lista paginada del más nuevo al más viejo, con desempate estable y cursor opaco; cumple el contrato', async () => {
    const { payer, beneficiary } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 1000);
      ids.push((await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: 1000 + i }))).body.id);
    }
    // Dos mandatos con la MISMA hora de creación: el desempate por id mantiene el orden entre páginas.
    const same = await Promise.all([createMandate(ctx, payer, mandateBody(beneficiary)), createMandate(ctx, payer, mandateBody(beneficiary))]);
    ids.push(...same.map((r) => r.body.id));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await pub(ctx, 'get', `/mandates?limit=3${cursor ? `&starting_after=${cursor}` : ''}`, payer);
      const body = verifiedMandate(ctx.publicContract, 'get', '/mandates', res, 200);
      seen.push(...body.data.map((m: { id: string }) => m.id));
      if (!body.has_more) {
        expect(body.next_cursor).toBeNull();
        break;
      }
      cursor = body.next_cursor;
      expect(cursor).toEqual(expect.any(String));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('límite del `limit` y cursor inválido: 1 y 100 valen; 0, 101, texto y cursor roto ⇒ 422', async () => {
    const { payer } = await setup();
    expect((await pub(ctx, 'get', '/mandates?limit=1', payer)).status).toBe(200);
    expect((await pub(ctx, 'get', '/mandates?limit=100', payer)).status).toBe(200);
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'starting_after=%7Bbasura', `starting_after=${Buffer.from('["x","y"]').toString('base64url')}`]) {
      expect({ bad, status: (await pub(ctx, 'get', `/mandates?${bad}`, payer)).status }).toEqual({ bad, status: 422 });
    }
  });

  it('cancelar: 204, el mandato queda `canceled` sin próxima fecha, se publica mandate.canceled una sola vez y repetir no hace nada', async () => {
    const { payer, beneficiary } = await setup();
    const { id } = (await createMandate(ctx, payer, mandateBody(beneficiary))).body;
    const first = await pub(ctx, 'delete', `/mandates/${id}`, payer);
    expect(first.status).toBe(204);
    ctx.publicContract.assertResponse({ method: 'delete', path: `/mandates/${id}`, status: 204, body: undefined });
    expect((await pub(ctx, 'delete', `/mandates/${id}`, payer)).status).toBe(204);
    expect(await rows(ctx, 'SELECT status, next_run_on FROM mandates WHERE id = $1', [id])).toEqual([{ status: 'canceled', next_run_on: null }]);
    expect(await eventsOf(ctx, 'mandate.canceled', id)).toHaveLength(1);
  });

  it('cancelar con concurrencia ×5 produce un solo evento', async () => {
    const { payer, beneficiary } = await setup();
    const { id } = (await createMandate(ctx, payer, mandateBody(beneficiary))).body;
    const results = await Promise.all(Array.from({ length: 5 }, () => pub(ctx, 'delete', `/mandates/${id}`, payer)));
    expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204, 204]);
    expect(await eventsOf(ctx, 'mandate.canceled', id)).toHaveLength(1);
  });
});

describe('multi-tenant y modo (D-28)', () => {
  it('otro comercio no ve ni cancela mis mandatos: 404, y la lista del otro está vacía', async () => {
    const { payer, beneficiary } = await setup();
    const other = newMerchant();
    const { id } = (await createMandate(ctx, payer, mandateBody(beneficiary))).body;
    expect((await pub(ctx, 'delete', `/mandates/${id}`, other)).status).toBe(404);
    expect((await pub(ctx, 'get', '/mandates', other)).body.data).toEqual([]);
    expect(await rows(ctx, 'SELECT status FROM mandates WHERE id = $1', [id])).toEqual([{ status: 'active' }]);
    for (const bad of ['x', 'md_', '../etc', 'md_ABC']) expect({ bad, status: (await pub(ctx, 'delete', `/mandates/${bad}`, payer)).status }).toEqual({ bad, status: 404 });
  });

  it('los mandatos de `test` y de `live` no se mezclan: no se listan ni se cancelan entre sí (404)', async () => {
    const { payer, beneficiary } = await setup();
    const test = (await createMandate(ctx, payer, mandateBody(beneficiary), uniqueKey(), 'test')).body;
    const live = (await createMandate(ctx, payer, mandateBody(beneficiary), uniqueKey(), 'live')).body;
    expect((await pub(ctx, 'get', '/mandates', payer, 'test')).body.data.map((m: { id: string }) => m.id)).toEqual([test.id]);
    expect((await pub(ctx, 'get', '/mandates', payer, 'live')).body.data.map((m: { id: string }) => m.id)).toEqual([live.id]);
    expect((await pub(ctx, 'delete', `/mandates/${live.id}`, payer, 'test')).status).toBe(404);
    expect((await pub(ctx, 'delete', `/mandates/${test.id}`, payer, 'live')).status).toBe(404);
    expect(await rows(ctx, 'SELECT id, status, mode FROM mandates WHERE merchant_id = $1 ORDER BY mode', [payer])).toEqual([
      { id: live.id, status: 'active', mode: 'live' },
      { id: test.id, status: 'active', mode: 'test' },
    ]);
    // La misma Idempotency-Key en otro modo es otra petición.
    const key = uniqueKey();
    expect((await createMandate(ctx, payer, mandateBody(beneficiary), key, 'test')).status).toBe(201);
    expect((await createMandate(ctx, payer, mandateBody(beneficiary), key, 'live')).status).toBe(201);
  });

  it('sin X-Pay-Mode o con un valor inválido, TODAS las rutas responden 403 (seguro por defecto)', async () => {
    const { payer, beneficiary } = await setup();
    const { id } = (await createMandate(ctx, payer, mandateBody(beneficiary))).body;
    const calls: [string, string][] = [['post', '/mandates'], ['get', '/mandates'], ['delete', `/mandates/${id}`]];
    for (const mode of [undefined, '', 'sandbox', 'LIVE', 'test,live', ' x ']) {
      for (const [method, path] of calls) {
        const req = request(ctx.server)[method as 'get'](path).set('x-service-id', 'pay-edge').set('x-merchant-id', payer).set('idempotency-key', uniqueKey());
        if (mode !== undefined) req.set('x-pay-mode', mode);
        const res = method === 'post' ? await req.send(mandateBody(beneficiary)) : await req;
        expect({ mode, path, method, status: res.status }).toEqual({ mode, path, method, status: 403 });
      }
    }
    expect(await rows(ctx, 'SELECT status FROM mandates WHERE id = $1', [id])).toEqual([{ status: 'active' }]);
  });

  it('el modo nunca sale del cuerpo: un campo `mode` en el cuerpo se rechaza', async () => {
    const { payer, beneficiary } = await setup();
    expect((await createMandate(ctx, payer, mandateBody(beneficiary, { mode: 'live' }), uniqueKey(), 'test')).status).toBe(422);
  });
});

describe('autorización (matriz negativa)', () => {
  it('solo pay-edge abre las rutas públicas; sin X-Merchant-Id o con uno mal formado es 403', async () => {
    const { payer, beneficiary } = await setup();
    const { id } = (await createMandate(ctx, payer, mandateBody(beneficiary))).body;
    const calls: [string, string][] = [['post', '/mandates'], ['get', '/mandates'], ['delete', `/mandates/${id}`]];
    for (const service of [undefined, 'pay-backoffice', 'pay-payments', 'pay-ledger']) {
      for (const [method, path] of calls) {
        const req = request(ctx.server)[method as 'get'](path).set('x-merchant-id', payer).set('x-pay-mode', 'test').set('idempotency-key', uniqueKey());
        if (service) req.set('x-service-id', service);
        const res = method === 'post' ? await req.send(mandateBody(beneficiary)) : await req;
        expect({ service, path, status: res.status }).toEqual({ service, path, status: 403 });
      }
    }
    for (const header of [undefined, '', 'mc_', "mc_x'; DROP TABLE mandates;--", 'merchant']) {
      for (const [method, path] of calls) {
        const req = request(ctx.server)[method as 'get'](path).set('x-service-id', 'pay-edge').set('x-pay-mode', 'test').set('idempotency-key', uniqueKey());
        if (header !== undefined) req.set('x-merchant-id', header);
        const res = method === 'post' ? await req.send(mandateBody(beneficiary)) : await req;
        expect({ header, path, status: res.status }).toEqual({ header, path, status: 403 });
      }
    }
    expect(await rows(ctx, 'SELECT status FROM mandates WHERE id = $1', [id])).toEqual([{ status: 'active' }]);
  });
});
