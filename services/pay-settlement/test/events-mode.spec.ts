import { setEventsCarryMode } from '../src/settlement/event-mode';
import { loadSettlementConfig } from '../src/settlement/settlement.config';
import { type SettlementTestContext, createSettlementContext, key, merchantId } from './helpers/app';
import { type EventValidator, loadEventValidators } from './helpers/events-contract';
import { BATCH_BODY, ref, registerMerchant } from './helpers/scenarios';

/**
 * `mode` en `settlement.batch.closed` y `reconciliation.exception.opened` (D-28). El AsyncAPI de hoy NO lo declara en esos dos: por defecto no se
 * emite. Encendido (`EVENTS_CARRY_MODE=true`) cada evento lleva el modo de su corte o corrida, sin tocar código, para cuando el contrato lo admita.
 * (`payout.*` ya lo llevan siempre: lo declara el contrato.)
 */
let ctx: SettlementTestContext;
let validators: Map<string, EventValidator>;
beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
});
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => {
  setEventsCarryMode(false);
  await ctx.close();
});

type Mode = 'test' | 'live';
async function exercise(mode: Mode) {
  const m = merchantId();
  await registerMerchant(ctx, m);
  const r = ref();
  ctx.ledger.seedCharge({ merchant: m, net: 5_000, fee: 0, at: new Date('2026-10-05T15:00:00Z'), ref: r, mode });
  await ctx.as('pay-console', mode).post('/batches', BATCH_BODY('2026-10-19')).set('idempotency-key', key());
  ctx.connectors.statements.set('mock', { format: 'json', lines: [{ provider_reference: 'B9', our_reference: ref(), direction: 'credit', amount_minor: 321, value_date: '2026-10-21', booked_at: '2026-10-21T14:30:00.000Z' }] });
  await ctx.as('pay-console', mode).post('/reconciliation_runs', { connector: 'mock', period_from: '2026-10-19T04:00:00.000Z', period_to: '2026-10-26T04:00:00.000Z' }).set('idempotency-key', key());
  await ctx.reconciliation.idle();
}

describe('mode en los eventos de settlement', () => {
  it('por defecto batch.closed y reconciliation.exception.opened NO llevan `mode` y validan contra el contrato de hoy; payout.* sí lo llevan', async () => {
    await exercise('live');
    for (const type of ['settlement.batch.closed', 'reconciliation.exception.opened']) {
      const events = await ctx.events(type);
      expect(events).toHaveLength(1);
      expect((events[0].data as Record<string, unknown>).mode).toBeUndefined();
      expect((validators.get(type) as EventValidator)(events[0])).toEqual([]);
    }
    const created = await ctx.events('payout.created');
    expect(created.every((e) => (e.data as { mode?: string }).mode === 'live')).toBe(true);
    expect(created).toHaveLength(1);
  });

  it.each(['test', 'live'] as const)('encendido, cada evento lleva el modo %s de su corte o corrida; contra el contrato solo puede diferir en `mode` (canario del cambio de contrato)', async (mode) => {
    setEventsCarryMode(true);
    await exercise(mode);
    for (const type of ['settlement.batch.closed', 'reconciliation.exception.opened']) {
      const events = await ctx.events(type);
      expect(events).toHaveLength(1);
      expect((events[0].data as { mode?: string }).mode).toBe(mode);
      const errors = (validators.get(type) as EventValidator)(events[0]);
      expect(errors.filter((x) => !/additional propert|\bmode\b/i.test(x))).toEqual([]);
    }
  });

  it('EVENTS_CARRY_MODE: apagado por defecto, true|false, otro valor falla al arrancar', () => {
    const env = { LEDGER_URL: 'http://l', CONNECTORS_URL: 'http://c', OPERATOR_TOKEN_PUBLIC_KEY: 'k', OPERATOR_TOKEN_ISSUER: 'i', OPERATOR_TOKEN_AUDIENCE: 'a' };
    expect(loadSettlementConfig(env).eventsCarryMode).toBe(false);
    expect(loadSettlementConfig({ ...env, EVENTS_CARRY_MODE: 'true' }).eventsCarryMode).toBe(true);
    expect(() => loadSettlementConfig({ ...env, EVENTS_CARRY_MODE: '1' })).toThrow(/EVENTS_CARRY_MODE/);
  });
});
