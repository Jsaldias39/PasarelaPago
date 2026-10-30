import { loadContract, type ContractValidator } from '@pay/testing';
import { PUBLIC_CONTRACT } from './harness';
import { SAMPLES } from './doubles/samples';

/** Regresión del defecto de `Mandate` (allOf + additionalProperties:false lo hacía imposible de cumplir). */
describe('public-v1.yaml — Mandate / MandateCreate', () => {
  let contract: ContractValidator;
  beforeAll(async () => {
    contract = await loadContract(PUBLIC_CONTRACT);
  });

  const valid = { kind: 'pay_obligation', beneficiary_merchant_id: 'mc_abcdefghij12', amount_minor: 50000, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: 5, start_date: '2026-11-05' } };
  const request = (body: unknown) => contract.validateRequest({ method: 'POST', path: '/mandates', body });

  it('CORRECTO: una petición válida y una respuesta real de Mandate cumplen el contrato', () => {
    expect(request(valid)).toEqual([]);
    expect(contract.validateResponse({ method: 'POST', path: '/mandates', status: 201, body: SAMPLES['POST /mandates'].body })).toEqual([]);
    expect(contract.validateResponse({ method: 'GET', path: '/mandates', status: 200, body: SAMPLES['GET /mandates'].body })).toEqual([]);
  });

  it('LÍMITE: la respuesta puede traer los campos que agrega Mandate (id, object, status, created_at)', () => {
    const body = { ...valid, id: 'md_abcdefghij12', object: 'mandate', status: 'active', next_run_on: null, created_at: '2026-10-27T12:00:00.000Z' };
    expect(contract.validateResponse({ method: 'POST', path: '/mandates', status: 201, body })).toEqual([]);
  });

  it.each([
    ['campo desconocido (asignación masiva)', { ...valid, status: 'active' }],
    ['id elegido por el cliente', { ...valid, id: 'md_abcdefghij12' }],
    ['sin schedule', { ...valid, schedule: undefined }],
    ['campo desconocido dentro de schedule', { ...valid, schedule: { ...valid.schedule, timezone: 'UTC' } }],
    ['importe cero', { ...valid, amount_minor: 0 }],
    ['día 29', { ...valid, schedule: { ...valid.schedule, day_of_month: 29 } }],
  ])('INVÁLIDO: la petición con %s se rechaza', (_name, body) => {
    expect(request(body)).not.toEqual([]);
  });

  it('INVÁLIDO: una respuesta sin id o con status inexistente no cumple', () => {
    const base = { ...valid, id: 'md_abcdefghij12', object: 'mandate', status: 'active', created_at: '2026-10-27T12:00:00.000Z' };
    expect(contract.validateResponse({ method: 'POST', path: '/mandates', status: 201, body: { ...base, id: undefined } })).not.toEqual([]);
    expect(contract.validateResponse({ method: 'POST', path: '/mandates', status: 201, body: { ...base, status: 'volando' } })).not.toEqual([]);
  });
});
