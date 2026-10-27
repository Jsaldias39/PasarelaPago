import { splitFee } from '@pay/money';
import { quoteFee, type ChannelRule } from '../src/fees/quote';
import { createTestContext, type TestContext } from './support/app';
import { activeMerchant, bo, createMerchant, eventsOf, uniqueKey, verified } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const publish = (id: string, body: object, as = 'op-pricing') => bo(ctx, 'post', `/merchants/${id}/fee_schedules`, as).send(body);
const quote = (id: string, channel: string, amount: number | string, as = 'op-merchant') => bo(ctx, 'get', `/merchants/${id}/fee_quote?channel=${channel}&amount_minor=${amount}`, as);
const current = (id: string, as = 'op-merchant') => bo(ctx, 'get', `/merchants/${id}/fee_schedules/current`, as);

const BASE: ChannelRule[] = [
  { channel: 'qr', percent: '3' },
  { channel: 'card', percent: '2.5', fixed_minor: 50 },
  { channel: 'direct', percent: '1.5' },
];

describe('tarifario versionado (REQ-P5-3, P5.H1.M5 y M7)', () => {
  it('kill-test del carril: Bs 100,00 por QR al 3 % ⇒ comisión 300 y neto 9700, y la versión sale en el contrato', async () => {
    const id = await createMerchant(ctx, 300);
    verified(ctx.backofficeContract, 'post', `/merchants/${id}/fee_schedules`, await publish(id, { channels: BASE }), 201);
    const body = verified(ctx.backofficeContract, 'get', `/merchants/${id}/fee_quote`, await quote(id, 'qr', 10000), 200);
    expect(body).toMatchObject({ channel: 'qr', amount_minor: 10000, fee_minor: 300, net_minor: 9700, schedule_version: 1 });
    // El mismo caso del test de @pay/money: 2,5 % + Bs 0,50 sobre Bs 100,00 ⇒ 3,00 / 97,00.
    expect(verified(ctx.backofficeContract, 'get', `/merchants/${id}/fee_quote`, await quote(id, 'card', 10000), 200)).toMatchObject({ fee_minor: 300, net_minor: 9700 });
  });

  it('el canal directo (7.9) se cotiza con su propia tasa', async () => {
    const id = await createMerchant(ctx, 301);
    await publish(id, { channels: BASE });
    const direct = (await quote(id, 'direct', 10000)).body;
    const qr = (await quote(id, 'qr', 10000)).body;
    expect(direct.fee_minor).toBe(150);
    expect(direct.fee_minor).toBeLessThan(qr.fee_minor);
  });

  it('cada publicación es una versión nueva e inmutable: la 1 sigue intacta y rige la mayor ya iniciada', async () => {
    const id = await createMerchant(ctx, 302);
    const v1 = verified(ctx.backofficeContract, 'post', `/merchants/${id}/fee_schedules`, await publish(id, { channels: [{ channel: 'qr', percent: '3' }] }), 201);
    expect(v1.version).toBe(1);
    const v2 = verified(ctx.backofficeContract, 'post', `/merchants/${id}/fee_schedules`, await publish(id, { monthly_fee_minor: 5000, channels: [{ channel: 'qr', percent: '2' }] }), 201);
    expect(v2).toMatchObject({ version: 2, monthly_fee_minor: 5000 });
    const now = verified(ctx.backofficeContract, 'get', `/merchants/${id}/fee_schedules/current`, await current(id), 200);
    expect(now.version).toBe(2);
    expect((await quote(id, 'qr', 10000)).body).toMatchObject({ fee_minor: 200, schedule_version: 2 });
    const stored = await ctx.db.pool.query('SELECT percent FROM fee_schedule_channels WHERE merchant_id = $1 AND version = 1', [id]);
    expect(stored.rows).toEqual([{ percent: '3' }]);
  });

  it('las versiones y sus canales son INMUTABLES a nivel de base (UPDATE, DELETE y TRUNCATE fallan)', async () => {
    const id = await createMerchant(ctx, 303);
    await publish(id, { channels: BASE });
    await expect(ctx.db.pool.query(`UPDATE fee_schedule_channels SET percent = '0' WHERE merchant_id = $1`, [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM fee_schedule_channels WHERE merchant_id = $1', [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('UPDATE fee_schedule_versions SET monthly_fee_minor = 0 WHERE merchant_id = $1', [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM fee_schedule_versions WHERE merchant_id = $1', [id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('TRUNCATE fee_schedule_versions CASCADE')).rejects.toThrow(/inmutable/);
    expect(Number((await ctx.db.pool.query('SELECT count(*)::int AS n FROM fee_schedule_channels WHERE merchant_id = $1', [id])).rows[0].n)).toBe(3);
  });

  it('una versión con vigencia futura no rige todavía; cuando empieza, pasa a regir (espera por condición, no por tiempo fijo)', async () => {
    const id = await createMerchant(ctx, 304);
    await publish(id, { channels: [{ channel: 'qr', percent: '3' }] });
    const startsAt = new Date(Date.now() + 1500);
    const v2 = await publish(id, { effective_from: startsAt.toISOString(), channels: [{ channel: 'qr', percent: '1' }] });
    expect(v2.status).toBe(201);
    expect((await current(id)).body.version).toBe(1);
    expect((await quote(id, 'qr', 10000)).body.fee_minor).toBe(300);
    const deadline = Date.now() + 10_000;
    let version = 1;
    while (version === 1 && Date.now() < deadline) {
      version = (await current(id)).body.version;
    }
    expect(version).toBe(2);
    expect((await quote(id, 'qr', 10000)).body.fee_minor).toBe(100);
    // No se puede publicar una versión que empiece antes que la anterior.
    const before = await publish(id, { effective_from: new Date(startsAt.getTime() - 1000).toISOString(), channels: [{ channel: 'qr', percent: '1' }] });
    expect([before.status, before.body.errors]).toEqual([422, [{ field: 'effective_from', code: 'before_previous_version' }]]);
  });

  it('publica fee_schedule.published por outbox, válido contra el AsyncAPI, sin datos personales y con la versión', async () => {
    const id = await createMerchant(ctx, 305);
    await publish(id, { monthly_fee_minor: 1200, channels: BASE });
    const events = await eventsOf(ctx, 'fee_schedule.published', `${id}:1`);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ merchant_id: id, version: 1, currency: 'BOB', effective_to: null, monthly_fee_minor: 1200 });
    expect(events[0].data.channels).toHaveLength(3);
    expect(JSON.stringify(events[0])).not.toMatch(/Sintético|tax_id|1000\d{6}/);
  });

  it('no publica el evento si la publicación falla (misma transacción)', async () => {
    const id = await createMerchant(ctx, 306);
    expect((await publish(id, { channels: [{ channel: 'qr', percent: '150' }] })).status).toBe(422);
    expect(await eventsOf(ctx, 'fee_schedule.published', `${id}:1`)).toHaveLength(0);
  });

  it('valida el tarifario con errores por campo (sin repetir valores)', async () => {
    const id = await createMerchant(ctx, 307);
    const cases: [string, object, { field: string; code: string }[]][] = [
      ['canal repetido', { channels: [{ channel: 'qr', percent: '1' }, { channel: 'qr', percent: '2' }] }, [{ field: 'channels[1].channel', code: 'duplicated' }]],
      ['porcentaje sobre 100', { channels: [{ channel: 'qr', percent: '100.5' }] }, [{ field: 'channels[0].percent', code: 'invalid' }]],
      ['porcentaje con 7 decimales', { channels: [{ channel: 'qr', percent: '1.1234567' }] }, [{ field: 'channels[0].percent', code: 'pattern' }]],
      ['mínimo sobre el tope', { channels: [{ channel: 'qr', percent: '1', min_minor: 500, cap_minor: 100 }] }, [{ field: 'channels[0].min_minor', code: 'above_cap' }]],
      ['abono negativo', { monthly_fee_minor: -1, channels: [{ channel: 'qr', percent: '1' }] }, []],
      ['canal inexistente', { channels: [{ channel: 'cripto', percent: '1' }] }, []],
      ['campo de más', { channels: [{ channel: 'qr', percent: '1', descuento: 1 }] }, []],
      ['sin canales', { channels: [] }, []],
      ['fijo como decimal', { channels: [{ channel: 'qr', percent: '1', fixed_minor: 0.5 }] }, []],
    ];
    for (const [name, body, errors] of cases) {
      const res = await publish(id, body);
      expect({ name, status: res.status }).toEqual({ name, status: 422 });
      if (errors.length > 0) expect({ name, errors: res.body.errors }).toEqual({ name, errors });
      // El error nombra el campo (no el valor): el valor enviado nunca se repite.
      expect(JSON.stringify(res.body)).not.toContain('cripto');
    }
    expect((await ctx.db.pool.query('SELECT 1 FROM fee_schedule_versions WHERE merchant_id = $1', [id])).rows).toHaveLength(0);
  });

  it('rechaza comercio inexistente (404), comercio cerrado (409) y effective_from en el pasado (422)', async () => {
    expect((await publish('mc_noexiste0000000000', { channels: BASE })).status).toBe(404);
    expect((await publish('no-es-un-id', { channels: BASE })).status).toBe(404);
    const id = await activeMerchant(ctx, 308);
    expect((await publish(id, { effective_from: '2000-01-01T00:00:00Z', channels: BASE })).body.errors).toEqual([{ field: 'effective_from', code: 'in_the_past' }]);
    expect((await bo(ctx, 'post', `/merchants/${id}/close`)).status).toBe(200);
    const closed = await publish(id, { channels: BASE });
    expect([closed.status, closed.body.errors]).toEqual([409, [{ field: 'status', code: 'from_closed' }]]);
  });

  it('publicar con concurrencia numera las versiones sin huecos ni repetidos', async () => {
    const id = await createMerchant(ctx, 309);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => publish(id, { channels: [{ channel: 'qr', percent: String(i + 1) }] })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  describe('cotización', () => {
    it('sin tarifario es 404; canal no configurado, importe inválido o canal inválido son 422', async () => {
      const id = await createMerchant(ctx, 310);
      expect((await quote(id, 'qr', 100)).status).toBe(404);
      expect((await current(id)).status).toBe(404);
      await publish(id, { channels: [{ channel: 'qr', percent: '3' }] });
      const notConfigured = await quote(id, 'card', 100);
      expect([notConfigured.status, notConfigured.body.errors]).toEqual([422, [{ field: 'channel', code: 'not_configured' }]]);
      for (const amount of ['0', '-5', '1.5', 'abc', '', '99999999999999999', '01']) {
        expect({ amount, status: (await quote(id, 'qr', amount)).status }).toEqual({ amount, status: 422 });
      }
      expect((await quote(id, 'cripto', 100)).status).toBe(422);
      expect((await quote('mc_noexiste0000000000', 'qr', 100)).status).toBe(404);
    });

    it('si la comisión (con su fijo) supera el importe es 422 fee_exceeds_amount; igualarlo es válido', async () => {
      const id = await createMerchant(ctx, 311);
      await publish(id, { channels: [{ channel: 'qr', percent: '0', fixed_minor: 50 }] });
      const exceeds = await quote(id, 'qr', 49);
      expect(exceeds.status).toBe(422);
      expect(exceeds.body.code).toBe('fee_exceeds_amount');
      expect((await quote(id, 'qr', 50)).body).toMatchObject({ fee_minor: 50, net_minor: 0 });
    });

    it('el empate de medio centavo queda del lado del comercio (D-20), igual que en @pay/money', async () => {
      const id = await createMerchant(ctx, 312);
      await publish(id, { channels: [{ channel: 'qr', percent: '10' }] });
      expect((await quote(id, 'qr', 5)).body).toMatchObject({ fee_minor: 0, net_minor: 5 });
      expect((await quote(id, 'qr', 15)).body).toMatchObject({ fee_minor: 1, net_minor: 14 });
    });

    it('el mínimo y el tope se aplican antes de redondear', async () => {
      const id = await createMerchant(ctx, 313);
      await publish(id, { channels: [{ channel: 'qr', percent: '1', min_minor: 50, cap_minor: 2000 }] });
      expect((await quote(id, 'qr', 1000)).body.fee_minor).toBe(50);
      expect((await quote(id, 'qr', 10_000_000)).body.fee_minor).toBe(2000);
    });
  });

  it('propiedad (5.000 casos, semilla fija): quoteFee es exactamente splitFee y comisión + neto = bruto', () => {
    let seed = 987654321n;
    const next = (limit: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % limit;
    };
    let checked = 0;
    for (let i = 0; i < 5000; i += 1) {
      const gross = next(10n ** 10n);
      const decimals = Number(next(7n));
      const scaled = next(100n * 10n ** BigInt(decimals) + 1n);
      const digits = scaled.toString().padStart(decimals + 1, '0');
      const percent = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
      const rule: ChannelRule = { channel: 'qr', percent, fixed_minor: Number(next(500n)) };
      let expected;
      try {
        expected = splitFee(gross, { percent, fixedMinor: BigInt(rule.fixed_minor ?? 0) });
      } catch {
        expect(() => quoteFee([rule], 'qr', gross)).toThrow();
        continue;
      }
      const got = quoteFee([rule], 'qr', gross);
      expect(got.fee_minor).toBe(expected.feeMinor);
      expect(got.net_minor).toBe(expected.netMinor);
      expect(got.fee_minor + got.net_minor).toBe(gross);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('autorización: publicar exige pricing_admin; cotizar y leer exigen merchant_operator; sin token es 401', async () => {
    const id = await createMerchant(ctx, 314);
    expect((await publish(id, { channels: BASE }, 'op-merchant')).status).toBe(403);
    expect((await publish(id, { channels: BASE }, 'op-norole')).status).toBe(403);
    expect((await publish(id, { channels: BASE }, 'op-nadie')).status).toBe(401);
    expect((await publish(id, { channels: BASE }, 'op-pricing')).status).toBe(201);
    expect((await quote(id, 'qr', 100, 'op-pricing')).status).toBe(403);
    expect((await current(id, 'op-kyc')).status).toBe(403);
    const anonymous = await bo(ctx, 'get', `/merchants/${id}/fee_quote?channel=qr&amount_minor=100`).unset('authorization');
    expect(anonymous.status).toBe(401);
    const wrongService = await bo(ctx, 'post', `/merchants/${id}/fee_schedules`).set('x-service-id', 'pay-payments').send({ channels: BASE });
    expect(wrongService.status).toBe(403);
  });

  it('publicar el tarifario no es idempotente por clave: repetir el mismo cuerpo crea otra versión (decisión registrada)', async () => {
    // Publicar el tarifario no es idempotente por clave: cada POST es una versión. Se registra como decisión (DECISIONES-TOMADAS).
    const id = await createMerchant(ctx, 315);
    const body = { channels: [{ channel: 'qr', percent: '3' }] };
    const first = await publish(id, body).set('idempotency-key', uniqueKey());
    const second = await publish(id, body).set('idempotency-key', uniqueKey());
    expect([first.body.version, second.body.version]).toEqual([1, 2]);
  });
});
