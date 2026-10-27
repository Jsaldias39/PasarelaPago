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
