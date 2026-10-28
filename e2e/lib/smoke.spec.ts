import { classify, fill, loadOperations } from './smoke.ts';

describe('clasificación del humo (el instrumento tiene que detectar fallas)', () => {
  const withParams = { method: 'GET', path: '/x/{id}', hasPathParams: true, params: [{ name: 'id' }] };
  const noParams = { method: 'GET', path: '/x', hasPathParams: false, params: [] };

  it.each([
    [200, withParams, 'OK'],
    [201, noParams, 'OK'],
    [404, withParams, 'OK'], // un recurso que no existe es una respuesta legítima
    [422, noParams, 'OK'],
    [409, noParams, 'OK'],
    [401, noParams, 'FALLA_IDENTIDAD'],
    [403, withParams, 'FALLA_IDENTIDAD'],
    [404, noParams, 'RUTA_AUSENTE'], // una colección sin ruta en el dueño
    [500, noParams, 'FALLA_5XX'],
    [502, withParams, 'FALLA_5XX'],
    [0, noParams, 'INALCANZABLE'],
  ])('status %i (%j) ⇒ %s', (status, op, verdict) => {
    expect(classify(status, op).verdict).toBe(verdict);
  });
});

describe('operaciones de los contratos', () => {
  it('lee las operaciones y detecta los parámetros de ruta aunque vengan por $ref', () => {
    const ledger = loadOperations('internal-ledger-v1.yaml');
    expect(ledger.length).toBeGreaterThanOrEqual(8);
    const hold = ledger.find((o) => o.path === '/holds/{id}' && o.method === 'GET');
    expect(hold?.hasPathParams).toBe(true);
    expect(fill(hold!)).not.toContain('{');
  });

  it('el valor de ejemplo cumple los patrones sencillos del contrato público', () => {
    const op = loadOperations('public-v1.yaml').find((o) => o.path === '/webhook_endpoints/{id}' && o.method === 'DELETE')!;
    expect(fill(op)).toMatch(/^\/webhook_endpoints\/we_a{10}$/);
  });
});

describe('el validador del contrato público que usa el humo detecta incumplimientos (control negativo del instrumento)', () => {
  const load = async () => (await import('@pay/testing')).loadContract(`${process.cwd()}/contracts/openapi/public-v1.yaml`);

  it('una respuesta que el contrato declara pasa; una forma ajena, un estado no declarado y una operación inexistente fallan', async () => {
    const contract = await load();
    const problem = { type: 'urn:alovida:pay:problem:validation_failed', title: 'La petición no es válida', status: 422, code: 'validation_failed' };
    expect(contract.validateResponse({ method: 'POST', path: '/payment_intents', status: 422, body: problem })).toEqual([]);
    expect(contract.validateResponse({ method: 'POST', path: '/payment_intents', status: 422, body: { esto: 'no es un problem+json' } }).length).toBeGreaterThan(0);
    expect(contract.validateResponse({ method: 'POST', path: '/payment_intents', status: 418, body: problem }).length).toBeGreaterThan(0);
    expect(contract.validateResponse({ method: 'GET', path: '/no_existe', status: 200, body: {} }).length).toBeGreaterThan(0);
  });
});
