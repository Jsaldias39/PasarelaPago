import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { LedgerController, PublicLedgerController } from '../src/ledger/ledger.controller';
import { type LedgerTestContext, KNOWN_422_GAPS, createLedgerContext, merchantId, repoPath } from './helpers/app';
import { loadContract } from '@pay/testing';

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

/** `METHOD /ruta/{}` de cada handler con decoradores de ruta; `:x` y `{x}` se normalizan para comparar por posición. */
function routesOf(controller: { prototype: Record<string, unknown> }): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined)
    .map((name) => {
      const handler = proto[name] as object;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      return `${method} /${String(Reflect.getMetadata(PATH_METADATA, handler)).replace(/:[A-Za-z_]+/g, '{}')}`;
    })
    .sort();
}
const normalize = (ops: string[]) => ops.map((op) => op.replace(/\{[^}]+\}/g, '{}')).sort();
const sample = (path: string) => path.replace('{business_ref}', encodeURIComponent('pi_aaaaaaaaaa:capture')).replace('{id}', 'hd_aaaaaaaaaaaa');

describe('el servicio implementa TODO el contrato', () => {
  it('cada operación de internal-ledger-v1.yaml tiene su ruta, y no hay rutas internas que el contrato no declare', () => {
    expect(routesOf(LedgerController as never)).toEqual(normalize(ctx.contract.operations()));
  });

  it('`GET /balance` de public-v1.yaml está implementado (la parte de P2 en pay-ledger)', async () => {
    const publicContract = await loadContract(repoPath('contracts/openapi/public-v1.yaml'));
    expect(normalize(publicContract.operations())).toContain('GET /balance');
    expect(routesOf(PublicLedgerController as never)).toEqual(['GET /balance']);
  });
});

describe('identidad entre servicios: cada ruta niega sin identidad y a los servicios que no están en su lista', () => {
  const internal = () => ctx.contract.operations().map((op) => op.split(' ') as [string, string]);

  it.each([
    ['sin identidad de servicio', undefined],
    ['pay-edge (solo atiende rutas públicas)', 'pay-edge'],
    ['pay-risk (no está en la política de cuentas)', 'pay-risk'],
    ['un valor con forma inválida', 'PAY_PAYMENTS'],
  ])('%s ⇒ 403 en TODAS las rutas internas', async (_name, service) => {
    for (const [method, template] of internal()) {
      const path = sample(template);
      const url = `${ctx.baseUrl}${path}`;
      const { default: request } = await import('supertest');
      let req = method === 'GET' ? request(ctx.baseUrl).get(path) : request(ctx.baseUrl).post(path).send({});
      if (service) req = req.set('x-service-id', service);
      const res = await req;
      expect([method, template, res.status, url.length > 0]).toEqual([method, template, 403, true]);
    }
  });

  it('un servicio de la política SÍ pasa el guard (la ruta responde otra cosa que 403)', async () => {
    for (const [method, template] of internal()) {
      const res = method === 'GET' ? await ctx.as('pay-settlement').get(sample(template)) : await ctx.as('pay-settlement').post(sample(template), {});
      expect([method, template, res.status === 403]).toEqual([method, template, false]);
    }
  });

  it('`GET /balance` público: solo pay-edge', async () => {
    expect((await ctx.as('pay-payments').get('/balance').set('x-merchant-id', merchantId())).status).toBe(403);
    expect((await ctx.as('pay-edge').get('/balance').set('x-merchant-id', merchantId())).status).toBe(200);
  });
});

describe('divergencias conocidas del contrato (PROPUESTAS.md #4)', () => {
  it('siguen siendo ciertas: si el contrato ya declara el 422, hay que borrar la entrada de KNOWN_422_GAPS', () => {
    for (const template of KNOWN_422_GAPS) {
      const [method, path] = template.split(' ');
      const errors = ctx.contract.validateResponse({ method, path: sample(path), status: 422, body: {} });
      expect([template, errors[0] ?? '']).toEqual([template, expect.stringContaining('no declara la respuesta 422')]);
    }
  });
});
