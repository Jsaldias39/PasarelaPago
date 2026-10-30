import { PROBLEM_CATALOG } from '/home/user/pasarelapago/contracts/packages/problem/src/catalog';
import { problem } from '/home/user/pasarelapago/contracts/packages/problem/src/problem';
import { parseProblem } from './payments-gateway.errors';

const out = (m: string) => process.stdout.write(`R4P> ${m}\n`);

describe('REV4 parseProblem contra el catalogo REAL de la pasarela', () => {
  it('todo codigo del catalogo, construido con el problem() real, se reconoce', () => {
    const codes = Object.keys(PROBLEM_CATALOG);
    const bad: string[] = [];
    for (const code of codes) {
      const body = problem(code as never, { detail: 'x', instance: '/v1/payment_intents', requestId: 'req_1' });
      const parsed = parseProblem(JSON.parse(JSON.stringify(body)));
      if (!parsed || parsed.code !== code) bad.push(code);
    }
    out(`catalogo: ${codes.length} codigos; no reconocidos: ${JSON.stringify(bad)}`);
    expect(bad).toEqual([]);
  });

  it('con errores de campo (422 validation_failed) y sin campos opcionales', () => {
    const withErrors = problem('validation_failed' as never, { errors: [{ field: 'amount_minor', code: 'invalid_amount' }] });
    const bare = problem('idempotency_key_reused' as never);
    expect(parseProblem(JSON.parse(JSON.stringify(withErrors)))?.code).toBe('validation_failed');
    expect(parseProblem(JSON.parse(JSON.stringify(bare)))?.code).toBe('idempotency_key_reused');
  });

  it.each([
    ['proxy con code string', { code: 'upstream_blocked', message: 'x' }],
    ['sin type', { title: 't', status: 404, code: 'not_found' }],
    ['type ajeno (sandbox mockbank)', { type: 'urn:sandbox:mockbank:problem:x', title: 'x', status: 404, code: 'x' }],
    ['status fuera de rango', { type: 'urn:alovida:pay:problem:x', title: 'x', status: 200, code: 'x' }],
    ['status string', { type: 'urn:alovida:pay:problem:x', title: 'x', status: '404', code: 'x' }],
    ['code en mayusculas', { type: 'urn:alovida:pay:problem:x', title: 'x', status: 404, code: 'X' }],
    ['title vacio', { type: 'urn:alovida:pay:problem:x', title: '', status: 404, code: 'x' }],
    ['array', [{ code: 'x' }]],
  ])('no se reconoce: %s', (_n, body) => {
    expect(parseProblem(body)).toBeUndefined();
  });

  it('un JSON ajeno que IMITA la forma completa del contrato SI se reconoce (limite: no hay autenticidad)', () => {
    const forged = { type: 'urn:alovida:pay:problem:resource_not_found', title: 'x', status: 404, code: 'resource_not_found' };
    out(`imitacion completa reconocida=${parseProblem(forged) !== undefined}`);
  });
});
