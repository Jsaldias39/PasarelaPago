import { randomUUID } from 'node:crypto';
import { newCloudEvent, processOnce } from '@pay/outbox';
import { applyMerchantEvent, merchantStatus, parseMerchantEvent } from '../src/replica/merchant-replica';
import { createTestContext, type TestContext } from './support/app';
import { newMerchant } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const event = (type: string, merchantId: string, at: string, over: Record<string, unknown> = {}) => {
  const field = { 'merchant.activated': 'activated_at', 'merchant.suspended': 'suspended_at', 'merchant.closed': 'closed_at' }[type] as string;
  return { ...newCloudEvent({ source: '/pay-merchants', type, subject: merchantId, merchantId, data: { merchant_id: merchantId, status: 'x', [field]: at } }), ...over };
};
const apply = async (raw: unknown) => {
  const parsed = parseMerchantEvent(raw);
  if (!parsed) return 'rejected';
  return processOnce(ctx.db.pool, 'pay-schedules.merchant-replica', parsed.eventId, (client) => applyMerchantEvent(client, parsed));
};
const status = (id: string) => merchantStatus(ctx.db.pool, id);

describe('réplica del estado de comercios por eventos merchant.* (inbox)', () => {
  it('correcto: activated → suspended → closed actualiza el estado', async () => {
    const id = newMerchant();
    expect(await status(id)).toBeNull();
    expect(await apply(event('merchant.activated', id, '2026-03-01T10:00:00Z'))).toBe('processed');
    expect(await status(id)).toBe('active');
    await apply(event('merchant.suspended', id, '2026-03-02T10:00:00Z'));
    expect(await status(id)).toBe('suspended');
    await apply(event('merchant.closed', id, '2026-03-03T10:00:00Z'));
    expect(await status(id)).toBe('closed');
  });

  it('límite: un evento más viejo que lo ya sabido no pisa el estado (llegada desordenada); a igual hora gana el más restrictivo', async () => {
    const id = newMerchant();
    await apply(event('merchant.closed', id, '2026-03-05T10:00:00Z'));
    await apply(event('merchant.suspended', id, '2026-03-04T10:00:00Z')); // llega tarde
    await apply(event('merchant.activated', id, '2026-03-01T10:00:00Z')); // llega tarde
    expect(await status(id)).toBe('closed');

    const same = newMerchant();
    await apply(event('merchant.activated', same, '2026-03-05T10:00:00Z'));
    await apply(event('merchant.suspended', same, '2026-03-05T10:00:00Z'));
    expect(await status(same)).toBe('suspended');
    await apply(event('merchant.activated', same, '2026-03-05T10:00:00Z')); // mismo instante: no reactiva
    expect(await status(same)).toBe('suspended');
    await apply(event('merchant.activated', same, '2026-03-06T10:00:00Z'));
    expect(await status(same)).toBe('active');
  });

  it('el mismo evento entregado 5 veces a la vez tiene un solo efecto (inbox)', async () => {
    const id = newMerchant();
    const raw = event('merchant.activated', id, '2026-03-01T10:00:00Z');
    const results = await Promise.all(Array.from({ length: 5 }, () => apply(raw)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    expect(await status(id)).toBe('active');
  });

  it.each([
    ['no es un objeto', 'texto'],
    ['sin specversion', { ...event('merchant.activated', 'mc_abcdefghij12', '2026-03-01T10:00:00Z'), specversion: undefined }],
    ['otro emisor', event('merchant.activated', 'mc_abcdefghij12', '2026-03-01T10:00:00Z', { source: '/pay-otro' })],
    ['id que no es UUID', event('merchant.activated', 'mc_abcdefghij12', '2026-03-01T10:00:00Z', { id: 'no-uuid' })],
    ['tipo ajeno', event('api_key.created', 'mc_abcdefghij12', '2026-03-01T10:00:00Z')],
    ['comercio mal formado', event('merchant.activated', 'MC_1', '2026-03-01T10:00:00Z')],
    ['hora inválida', event('merchant.activated', 'mc_abcdefghij12', 'ayer')],
    ['sin datos', { ...event('merchant.activated', 'mc_abcdefghij12', '2026-03-01T10:00:00Z'), data: null }],
  ])('inválido: %s ⇒ se rechaza sin tocar la réplica', async (_name, raw) => {
    expect(parseMerchantEvent(raw)).toBeNull();
    expect((await ctx.db.pool.query('SELECT 1 FROM merchant_replica WHERE merchant_id = $1', ['mc_abcdefghij12'])).rows).toHaveLength(0);
    void randomUUID;
  });

  // D-33: pay-merchants añade `legal_name` a merchant.created/activated para pay-payments. pay-schedules NO lo necesita: lo ignora y no lo guarda.
  describe('legal_name (D-33) en merchant.activated', () => {
    const LEGAL = 'CENTINELA-RAZON-SOCIAL-SCHEDULES';
    const tables = async (): Promise<string> => {
      const { rows } = await ctx.db.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
      let all = '';
      for (const row of rows as { table_name: string }[]) all += JSON.stringify((await ctx.db.pool.query(`SELECT t::text AS r FROM "${row.table_name}" t`)).rows);
      return all;
    };

    it('correcto: el evento con razón social se procesa igual y la razón social no queda en ninguna tabla ni en los logs', async () => {
      const id = newMerchant();
      const raw = event('merchant.activated', id, '2026-04-01T10:00:00Z', { data: { merchant_id: id, status: 'active', activated_at: '2026-04-01T10:00:00Z', legal_name: LEGAL } });
      const parsed = parseMerchantEvent(raw);
      expect(parsed).toEqual({ eventId: expect.any(String), merchantId: id, status: 'active', at: '2026-04-01T10:00:00.000Z' }); // el evento tipado no lleva el dato
      expect(await apply(raw)).toBe('processed');
      expect(await status(id)).toBe('active');
      expect(await tables()).not.toContain(LEGAL);
      expect(ctx.logs.join('\n')).not.toContain(LEGAL);
    });

    it('límite: 1 y 300 caracteres no cambian el resultado, y un duplicado con la razón social tiene un solo efecto', async () => {
      for (const name of ['A', 'B'.repeat(300)]) {
        const id = newMerchant();
        expect(await apply(event('merchant.activated', id, '2026-04-02T10:00:00Z', { data: { merchant_id: id, status: 'active', activated_at: '2026-04-02T10:00:00Z', legal_name: name } }))).toBe('processed');
        expect(await status(id)).toBe('active');
      }
      const id = newMerchant();
      const raw = event('merchant.activated', id, '2026-04-03T10:00:00Z', { data: { merchant_id: id, status: 'active', activated_at: '2026-04-03T10:00:00Z', legal_name: LEGAL } });
      expect([await apply(raw), await apply(raw)]).toEqual(['processed', 'duplicate']);
    });

    it('inválido: un `legal_name` mal formado (número, objeto, nulo) tampoco se guarda ni rompe el procesamiento del estado; merchant.created no entra en la réplica', async () => {
      for (const bad of [12345, { a: LEGAL }, null]) {
        const id = newMerchant();
        expect(await apply(event('merchant.activated', id, '2026-04-04T10:00:00Z', { data: { merchant_id: id, status: 'active', activated_at: '2026-04-04T10:00:00Z', legal_name: bad } }))).toBe('processed');
        expect(await status(id)).toBe('active');
      }
      const created = newMerchant();
      const raw = { ...newCloudEvent({ source: '/pay-merchants', type: 'merchant.created', subject: created, merchantId: created, data: { merchant_id: created, status: 'pending', created_at: '2026-04-05T10:00:00Z', legal_name: LEGAL } }) };
      expect(parseMerchantEvent(raw)).toBeNull();
      expect(await status(created)).toBeNull();
      expect(await tables()).not.toContain(LEGAL);
    });
  });
});
