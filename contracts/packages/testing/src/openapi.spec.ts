import { join } from 'node:path';
import { loadContract, type ContractValidator } from './openapi';

const SPEC = join(__dirname, '../../../openapi/public-v1.yaml');
let contract: ContractValidator;
beforeAll(async () => {
  contract = await loadContract(SPEC);
});

const intent = {
  id: 'pi_abcdefghij12',
  object: 'payment_intent',
  amount_minor: 10000,
  currency: 'BOB',
  status: 'requires_action',
  payment_method_type: 'qr',
  fee_minor: 300,
  net_minor: 9700,
  created_at: '2026-10-27T15:00:00Z',
  expires_at: '2026-10-27T16:00:00Z',
};

describe('loadContract (contra public-v1.yaml)', () => {
  it('lista las operaciones del contrato', () => {
    const ops = contract.operations();
    expect(ops).toContain('POST /payment_intents');
    expect(ops).toContain('GET /payment_intents/{id}');
    expect(ops).toHaveLength(19); // conteo independiente del YAML: 19 operaciones
  });

  it('acepta una respuesta que cumple el contrato', () => {
    expect(contract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: intent })).toEqual([]);
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_abcdefghij12', status: 200, body: intent })).toEqual([]);
  });

  it('rechaza una respuesta a la que le falta un campo requerido o trae un tipo incorrecto', () => {
    const missing: Record<string, unknown> = { ...intent };
    delete missing.net_minor;
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_abcdefghij12', status: 200, body: missing }).join()).toContain('net_minor');
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_abcdefghij12', status: 200, body: { ...intent, amount_minor: '100.00' } }).length).toBeGreaterThan(0);
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_abcdefghij12', status: 200, body: { ...intent, status: 'inventado' } }).length).toBeGreaterThan(0);
  });

  it('valida los errores como application/problem+json con código del catálogo', () => {
    const problem = { type: 'urn:alovida:pay:problem:resource_not_found', title: 'No existe el recurso', status: 404, code: 'resource_not_found' };
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_x', status: 404, body: problem })).toEqual([]);
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_x', status: 404, body: { ...problem, extra: 1 } }).length).toBeGreaterThan(0);
  });

  it('rechaza una petición con campos no declarados y una ruta o un estado que el contrato no define', () => {
    expect(contract.validateRequest({ method: 'POST', path: '/payment_intents', body: { amount_minor: 100, currency: 'BOB', payment_method: { type: 'qr' } } })).toEqual([]);
    expect(contract.validateRequest({ method: 'POST', path: '/payment_intents', body: { amount_minor: 100, currency: 'BOB', payment_method: { type: 'qr' }, hack: true } }).length).toBeGreaterThan(0);
    expect(contract.validateRequest({ method: 'POST', path: '/payment_intents', body: { amount_minor: 0, currency: 'BOB', payment_method: { type: 'qr' } } }).length).toBeGreaterThan(0);
    expect(contract.validateResponse({ method: 'GET', path: '/no_existe', status: 200, body: {} })[0]).toContain('no define');
    expect(contract.validateResponse({ method: 'GET', path: '/payment_intents/pi_x', status: 418, body: {} })[0]).toContain('no declara la respuesta 418');
  });

  it('assertResponse lanza con un mensaje que dice qué campo falla', () => {
    expect(() => contract.assertResponse({ method: 'GET', path: '/balance', status: 200, body: { object: 'balance' } })).toThrow(/no cumple el contrato/);
  });
});
