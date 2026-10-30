import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { PROBLEM_CATALOG, type ProblemCode } from './catalog';
import { isProblemDetails, problem, ProblemError } from './problem';

const schema = JSON.parse(
  readFileSync(join(__dirname, '../../../schemas/problem.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ strict: true }).compile(schema);

describe('problem (RFC 9457)', () => {
  const codes = Object.keys(PROBLEM_CATALOG) as ProblemCode[];

  it.each(codes)('el cuerpo de %s cumple el JSON Schema', (code) => {
    const body = problem(code, { detail: 'x', instance: '/v1/payment_intents', requestId: 'req_1' });
    expect(validate(body)).toBe(true);
  });

  it('los códigos son únicos, en minúsculas con guion bajo y el estado es 4xx o 5xx', () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(PROBLEM_CATALOG[code].status).toBeGreaterThanOrEqual(400);
      expect(PROBLEM_CATALOG[code].status).toBeLessThan(600);
    }
  });

  it('el catálogo no cambió los códigos que el plan nombra (REQ-P1-2, REQ-P3-1, REQ-P2-2)', () => {
    expect(problem('idempotency_key_required').status).toBe(400);
    expect(problem('idempotency_key_reused').status).toBe(422);
    expect(problem('insufficient_funds').status).toBe(422);
    expect(problem('merchant_suspended').status).toBe(403);
  });

  it('un error por campo también cumple el esquema', () => {
    const body = problem('validation_failed', { errors: [{ field: 'amount_minor', code: 'out_of_range' }] });
    expect(validate(body)).toBe(true);
  });

  it('ProblemError se traduce al cuerpo del catálogo', () => {
    const error = new ProblemError('insufficient_funds', { detail: 'Saldo menor al débito' });
    expect(error.status).toBe(422);
    expect(error.toProblem()).toMatchObject({ code: 'insufficient_funds', status: 422, detail: 'Saldo menor al débito' });
    expect(isProblemDetails(error.toProblem())).toBe(true);
  });

  it('el esquema rechaza un cuerpo sin código y uno con campos extra', () => {
    expect(validate({ type: 'urn:alovida:pay:problem:x', title: 't', status: 400 })).toBe(false);
    expect(validate({ ...problem('unauthorized'), extra: 1 })).toBe(false);
  });

  it('isProblemDetails rechaza lo que no es un problema conocido', () => {
    expect(isProblemDetails(null)).toBe(false);
    expect(isProblemDetails({ type: 't', title: 't', status: 400, code: 'inventado' })).toBe(false);
  });
});
