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
});
