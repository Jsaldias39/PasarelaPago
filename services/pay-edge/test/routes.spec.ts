import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadContract } from '@pay/testing';
import { ROUTES, matchRoute } from '../src/routes';
import { PUBLIC_CONTRACT } from './harness';

type Parameter = { $ref?: string; name?: string; in?: string };
type Operation = { parameters?: Parameter[] };
const raw = parse(readFileSync(PUBLIC_CONTRACT, 'utf8')) as { paths: Record<string, Record<string, Operation>> };
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

describe('tabla de rutas vs contrato public-v1.yaml', () => {
  it('tiene EXACTAMENTE las operaciones del contrato (ninguna de más, ninguna de menos)', async () => {
    const contract = await loadContract(PUBLIC_CONTRACT);
    const fromRoutes = ROUTES.map((r) => `${r.method} ${r.template}`).sort();
    expect(fromRoutes).toEqual([...contract.operations()].sort());
    expect(fromRoutes).toHaveLength(20);
  });

  it.each(ROUTES.map((r) => [`${r.method} ${r.template}`, r] as const))('%s: Idempotency-Key y consulta coinciden con el contrato', (_name, route) => {
    const operation = raw.paths[route.template][route.method.toLowerCase()];
    const parameters = operation.parameters ?? [];
    const requiresKey = parameters.some((p) => p.$ref?.endsWith('parameters/IdempotencyKey'));
    expect(route.idempotencyKey).toBe(requiresKey);
    const fromContract = parameters
      .flatMap((p) => (p.$ref?.endsWith('parameters/Limit') ? ['limit'] : p.$ref?.endsWith('parameters/StartingAfter') ? ['starting_after'] : p.in === 'query' && p.name ? [p.name] : []))
      .sort();
    expect([...route.query].sort()).toEqual(fromContract);
  });

  it('cada método del contrato está cubierto (no hay operaciones put/patch sin ruta)', () => {
    const declared = Object.values(raw.paths).flatMap((item) => Object.keys(item).filter((m) => METHODS.includes(m)));
    expect(declared).toHaveLength(ROUTES.length);
  });
});

describe('matchRoute', () => {
  it('reconstruye la ruta desde la plantilla', () => {
    expect(matchRoute('GET', '/payment_intents/pi_abcdefghij12')).toMatchObject({ path: '/payment_intents/pi_abcdefghij12', rule: { upstream: 'pay-payments' } });
    expect(matchRoute('POST', '/webhook_endpoints/we_abc/rotate_secret')?.rule.upstream).toBe('pay-webhooks');
    expect(matchRoute('GET', '/balance')?.rule.upstream).toBe('pay-ledger');
    expect(matchRoute('GET', '/payouts')?.rule.upstream).toBe('pay-settlement');
    expect(matchRoute('DELETE', '/mandates/md_abc')?.rule.upstream).toBe('pay-schedules');
  });

  it.each([
    ['recorrido de rutas', '/payment_intents/../balance'],
    ['punto en el id', '/payment_intents/pi.abc'],
    ['codificado', '/payment_intents/%2e%2e'],
    ['barra codificada', '/payment_intents/pi%2fabc'],
    ['mayúsculas', '/payment_intents/PI_ABC'],
    ['id de 65 caracteres', `/payment_intents/${'a'.repeat(65)}`],
    ['id vacío', '/payment_intents//cancel'],
    ['barra final', '/payment_intents/'],
    ['doble barra', '//payment_intents'],
    ['ruta interna', '/health/ready'],
    ['sufijo desconocido', '/payment_intents/pi_abc/secreto'],
  ])('no reconoce %s', (_name, path) => {
    expect(matchRoute('GET', path)).toBeUndefined();
    expect(matchRoute('POST', path)).toBeUndefined();
  });

  it('el método importa: no hay PUT/PATCH ni DELETE donde el contrato no lo define', () => {
    expect(matchRoute('PUT', '/payment_intents/pi_abc')).toBeUndefined();
    expect(matchRoute('DELETE', '/payment_intents/pi_abc')).toBeUndefined();
    expect(matchRoute('HEAD', '/balance')).toBeUndefined();
  });
});
