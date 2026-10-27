import { join } from 'node:path';
import { loadEventContract, type EventContract } from '@pay/testing';
import { readStream } from '../lib/events.ts';
import { mintOperatorToken, SYNTHETIC_LEGAL_NAME, seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { ROOT } from '../lib/infra.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * Alta de un comercio por la API REAL de pay-merchants (credencial de operador sintética + identidad `pay-backoffice`), no por la base.
 * Los eventos que el servicio publica se validan contra el AsyncAPI (`contracts/asyncapi/merchants-schedules.yaml`), incluida la razón social (D-33)
 * en `merchant.created` y `merchant.activated` y SOLO ahí. La primera clave se pide con la identidad de `pay-edge` (ver `onboardMerchant`).
 */
describe('alta de comercio por la API real de pay-merchants', () => {
  let stack: Stack;
  let contract: EventContract;
  let merchant: SeededMerchant;

  const merchantEvents = (id: string) => readStream(stack, 'PAY_MERCHANTS', 'pay-merchants.>', (e) => JSON.stringify(e.data).includes(id));

  beforeAll(async () => {
    contract = await loadEventContract(join(ROOT, 'contracts/asyncapi/merchants-schedules.yaml'));
    stack = await startStack({ only: ['pay-merchants', 'pay-edge'], tolerateFailures: false });
    merchant = await seedMerchant(stack, { label: 'COMERCIO ONBOARDING (SINTÉTICO)' });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack)).leftoverPids).toEqual([]);
  });

  describe('nivel correcto', () => {
    it('el comercio queda activo, con su clave sk_test_ reconocida por el borde', async () => {
      expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
      const me = await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } });
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({ id: merchant.merchantId, status: 'active' });
    });

    it('los eventos publicados cumplen el AsyncAPI y la razón social viaja en merchant.created y merchant.activated', async () => {
      const events = await until('los cuatro eventos del alta', () => merchantEvents(merchant.merchantId), (list) => ['merchant.created', 'merchant.activated', 'fee_schedule.published', 'api_key.created'].every((t) => list.some((e) => e.type === t)));
      for (const event of events) expect({ type: event.type, errors: contract.validate(`pay-merchants.${event.type}`, event.raw) }).toEqual({ type: event.type, errors: [] });
      for (const type of ['merchant.created', 'merchant.activated']) {
        expect(events.find((e) => e.type === type)!.data.legal_name).toBe(SYNTHETIC_LEGAL_NAME);
      }
      for (const event of events.filter((e) => e.type !== 'merchant.created' && e.type !== 'merchant.activated')) expect(JSON.stringify(event.raw)).not.toContain(SYNTHETIC_LEGAL_NAME);
    });
  });

  describe('nivel límite', () => {
    it('dar de alta un segundo comercio reutiliza la versión 1 del contrato y no interfiere con el primero', async () => {
      const second = await seedMerchant(stack, { label: 'COMERCIO ONBOARDING 2 (SINTÉTICO)' });
      expect(second.merchantId).not.toBe(merchant.merchantId);
      expect((await waitForEdgeToKnow(stack, second)).ok).toBe(true);
    });

    it('el respaldo directo (DOBLE) también publica eventos válidos con razón social', async () => {
      const direct = await seedMerchant(stack, { label: 'COMERCIO RESPALDO (SINTÉTICO)', mode: 'sql' });
      const events = await until('eventos del respaldo', () => merchantEvents(direct.merchantId), (list) => list.some((e) => e.type === 'merchant.activated') && list.some((e) => e.type === 'merchant.created'));
      for (const event of events) expect({ type: event.type, errors: contract.validate(`pay-merchants.${event.type}`, event.raw) }).toEqual({ type: event.type, errors: [] });
    });
  });

  describe('nivel inválido', () => {
    const create = (headers: Record<string, string>) =>
      fetch(`${stack.url('pay-merchants')}/merchants`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-invalid-0001', ...headers }, body: JSON.stringify({ display_name: 'X', legal_name: 'X SRL', legal_type: 'srl', tax_id: 'E2E000001' }) });

    it('sin credencial ⇒ 401; con un rol que no corresponde ⇒ 403; por un servicio que no es pay-backoffice ⇒ 403', async () => {
      expect((await create({ 'x-service-id': 'pay-backoffice' })).status).toBe(401);
      expect((await create({ 'x-service-id': 'pay-backoffice', authorization: `Bearer ${mintOperatorToken(stack, ['kyc_reviewer'])}` })).status).toBe(403);
      expect((await create({ 'x-service-id': 'pay-edge', authorization: `Bearer ${mintOperatorToken(stack, ['merchant_operator'])}` })).status).toBe(403);
    });

    it('una credencial vencida o con basura ⇒ 401', async () => {
      expect((await create({ 'x-service-id': 'pay-backoffice', authorization: `Bearer ${mintOperatorToken(stack, ['merchant_operator'], { ttlSeconds: -120 })}` })).status).toBe(401);
      expect((await create({ 'x-service-id': 'pay-backoffice', authorization: 'Bearer abc.def.ghi' })).status).toBe(401);
    });
  });
});
