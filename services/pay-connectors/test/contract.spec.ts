import { ChargesController } from '../src/http/charges.controller';
import { CallbacksController } from '../src/http/callbacks.controller';
import { ConnectorHealthController } from '../src/http/connector-health.controller';
import { RefundsController } from '../src/http/refunds.controller';
import { StatementsController } from '../src/http/statements.controller';
import { TransfersController } from '../src/http/transfers.controller';
import { asPaymentsIn, createTestApp, get, post, SPEC, type TestApp } from './support/app';
import { routesOf } from './support/routes';
import request from 'supertest';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const implemented = () => routesOf(ChargesController, RefundsController, TransfersController, StatementsController, CallbacksController, ConnectorHealthController);
/** Operaciones del contrato que no tienen ruta (lo que el test tiene que detectar). */
const missing = (operations: string[], routes: string[]) => operations.filter((op) => !routes.includes(op));

describe('el contrato y las rutas coinciden', () => {
  it('cada operación del contrato tiene su ruta, y no hay rutas fuera del contrato', () => {
    const operations = t.contract.operations().sort();
    expect(operations).toHaveLength(11);
    expect(missing(operations, implemented())).toEqual([]);
    expect(implemented().filter((r) => !operations.includes(r))).toEqual([]);
  });

  it('la prueba FALLA si una operación del contrato no tiene ruta (verificación del verificador)', () => {
    const operations = t.contract.operations();
    expect(missing(operations, implemented().filter((r) => r !== 'GET /statements'))).toEqual(['GET /statements']);
    expect(missing([...operations, 'POST /charges/{id}/capture'], implemented())).toEqual(['POST /charges/{id}/capture']);
  });

  it('usa el contrato de contracts/ y no una copia', () => {
    expect(SPEC.endsWith('contracts/openapi/internal-connectors-v1.yaml')).toBe(true);
  });
});

// Servicios que pueden llamar a cada operación (contrato: pay-payments cobra; pay-settlement concilia).
const MATRIX: Array<{ op: string; method: 'get' | 'post'; path: string; allowed: string[] }> = [
  { op: 'POST /charges', method: 'post', path: '/charges', allowed: ['pay-payments'] },
  { op: 'GET /charges/{id}', method: 'get', path: '/charges/ch_unknownunknown1', allowed: ['pay-payments', 'pay-settlement'] },
  { op: 'GET /charges/{id}/status', method: 'get', path: '/charges/ch_unknownunknown1/status', allowed: ['pay-payments', 'pay-settlement'] },
  { op: 'POST /charges/{id}/cancel', method: 'post', path: '/charges/ch_unknownunknown1/cancel', allowed: ['pay-payments'] },
  { op: 'POST /charges/{id}/refunds', method: 'post', path: '/charges/ch_unknownunknown1/refunds', allowed: ['pay-payments'] },
  { op: 'GET /refunds/{id}', method: 'get', path: '/refunds/cr_unknownunknown1', allowed: ['pay-payments'] },
  { op: 'POST /transfers', method: 'post', path: '/transfers', allowed: ['pay-settlement'] },
  { op: 'GET /transfers/{reference}', method: 'get', path: '/transfers/po_x:payout:1', allowed: ['pay-settlement'] },
  { op: 'GET /statements', method: 'get', path: '/statements', allowed: ['pay-settlement'] },
  { op: 'GET /connectors/health', method: 'get', path: '/connectors/health', allowed: ['pay-payments', 'pay-settlement'] },
];
const SERVICES = ['pay-payments', 'pay-settlement', 'pay-ledger', 'pay-vault', 'pay-merchants', 'pay-risk', 'pay-gateway', 'pay-qr', 'pay-connectors'];

describe('matriz de identidad: ruta × servicio llamador (denegado por defecto)', () => {
  it('la matriz cubre todas las operaciones protegidas del contrato', () => {
    const protectedOps = t.contract.operations().filter((op) => !op.includes('/callbacks/'));
    expect(MATRIX.map((m) => m.op).sort()).toEqual(protectedOps.sort());
  });

  for (const m of MATRIX) {
    describe(m.op, () => {
      it.each(SERVICES.filter((s) => !m.allowed.includes(s)))('%s ⇒ 403 forbidden', async (service) => {
        const response = await request(t.app.getHttpServer())[m.method](m.path).set('x-service-id', service).set('x-pay-mode', 'test').set('idempotency-key', 'k'.repeat(20)).send({});
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('forbidden');
        t.contract.assertResponse({ method: m.method.toUpperCase(), path: m.path.replace(/\?.*/, ''), status: 403, body: response.body });
      });

      it.each(m.allowed)('%s ⇒ pasa la identidad (cualquier cosa menos 403)', async (service) => {
        const response = await request(t.app.getHttpServer())[m.method](m.path).set('x-service-id', service).set('x-pay-mode', 'test').set('idempotency-key', 'k'.repeat(20)).send({});
        expect(response.status).not.toBe(403);
      });

      it.each([
        ['sin la cabecera', undefined],
        ['vacía', ''],
        ['con mayúsculas', 'Pay-Payments'],
        ['con guion bajo', 'pay_payments'],
        ['dos servicios', 'pay-payments,pay-settlement'],
        ['un nombre cualquiera', 'admin'],
        ['inyección de cabecera', 'pay-payments\r\nx-evil: 1'],
      ])('identidad inválida (%s) ⇒ 403', async (_name, value) => {
        const req = request(t.app.getHttpServer())[m.method](m.path).set('x-pay-mode', 'test').set('idempotency-key', 'k'.repeat(20));
        if (value !== undefined) req.set('x-service-id', value);
        let status: number;
        try {
          status = (await req.send({})).status;
        } catch (error) {
          // El cliente HTTP ni siquiera deja enviar una cabecera con salto de línea: el valor no llega al servicio.
          expect((error as Error).message).toMatch(/Invalid character in header/);
          return;
        }
        expect(status).toBe(403);
      });
    });
  }
});

describe('rutas públicas', () => {
  it('/health/* y /callbacks/{connectorId} no piden identidad de servicio (el callback se autentica con su firma)', async () => {
    expect((await request(t.app.getHttpServer()).get('/health/live')).status).toBe(200);
    expect((await request(t.app.getHttpServer()).post('/callbacks/mock').send('{}')).status).toBe(401);
  });

  it('una ruta que no existe es 404 aun con identidad válida', async () => {
    expect((await get(t.app, '/charges/ch_unknownunknown1/capture')).status).toBe(404);
    expect((await post(t.app, '/no-existe', {})).status).toBe(404);
  });
});

describe('modo live (D-26)', () => {
  it('con PAY_MODE=live el simulador no se carga: sin conectores, los cobros se rechazan y no hay callbacks de mock', async () => {
    const live = await createTestApp({ config: { mode: 'live' } });
    try {
      const health = await get(live.app, '/connectors/health', asPaymentsIn('live'));
      expect(health.status).toBe(200);
      expect(health.body.data).toEqual([]); // ni mock ni bank_transfer: sin adaptadores reales todavía
      const charge = await post(live.app, '/charges', { payment_intent_id: 'pi_aaaaaaaaaaaaaaaa', merchant_id: 'mc_aaaaaaaaaaaaaaaa', amount_minor: 10000, currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, asPaymentsIn('live'));
      expect(charge.status).toBe(502);
      expect(charge.body.code).toBe('connector_unavailable');
      expect((await request(live.app.getHttpServer()).post('/callbacks/mock').send('{}')).status).toBe(404);
      expect((await live.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(0);
    } finally {
      await live.close();
    }
  });
});
