import { createServer, type Server } from 'node:http';
import { ProblemError } from '@pay/problem';
import request from 'supertest';
import { asAdmin, asConnectors, chargeBody, createTestApp, deliver, get, post, type TestApp } from './support/app';

// Pagador simulado (P4.H4.M4) contra un pay-qr DOBLE declarado (stub HTTP de `POST /qr/decode`). El camino con el pay-qr REAL está en `payer-e2e.spec.ts`.
let t: TestApp;
let qrDouble: Server;
let decoded: Record<string, unknown> | { status: number };
let seenHeaders: Record<string, string | string[] | undefined> = {};
let seenBody = '';
void ProblemError;

const QR_A = '000201010212260400000062070503ABC63041234';
const QR_B = '000201010212260400000062070503XYZ63045678';
const QR_C = '000201010212260400000062070503LST63049999';

beforeAll(async () => {
  qrDouble = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seenHeaders = req.headers;
      seenBody = Buffer.concat(chunks).toString('utf8');
      if ('status' in decoded && typeof decoded.status === 'number') {
        res.statusCode = decoded.status;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(decoded));
    });
  });
  await new Promise<void>((resolve) => qrDouble.listen(0, '127.0.0.1', resolve));
  const port = (qrDouble.address() as { port: number }).port;
  t = await createTestApp({ config: { qrUrl: `http://127.0.0.1:${port}`, payerMode: 'manual' } });
});
afterAll(async () => {
  await t.close();
  qrDouble.closeAllConnections();
  await new Promise<void>((resolve) => qrDouble.close(() => resolve()));
});
beforeEach(async () => {
  await t.reset();
  decoded = { crc_valid: true, amount: '100.00', currency_numeric: '068' };
});

/** Cobro QR abierto en el banco con su QR registrado: el banco espera al pagador (modo manual). */
async function openQr(amountMinor = 10000, payload = QR_A) {
  const body = chargeBody({ amount_minor: amountMinor }, t.clock);
  await post(t, '/sandbox/charges', body);
  await request(t.app.getHttpServer()).put(`/sandbox/charges/${body.reference as string}/qr`).set(asConnectors).send({ payload });
  return body.reference as string;
}
const pay = (payload: string) => request(t.app.getHttpServer()).post('/sandbox/payer/pay').set(asAdmin).send({ qr_payload: payload });

describe('pagador simulado: paga un QR emitido por la pasarela', () => {
  it('correcto: modo manual deja el QR abierto; al pagarlo decodifica con pay-qr, queda cobrado y sale UN callback', async () => {
    const reference = await openQr();
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('pending');
    await deliver(t);
    expect(t.receiver.received).toHaveLength(0); // nadie pagó todavía
    const paid = await pay(QR_A);
    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ charge_reference: reference, status: 'captured', amount_minor: 10000, already_paid: false });
    expect(JSON.parse(seenBody)).toEqual({ payload: QR_A }); // lo decodificó pay-qr
    expect(seenHeaders['x-service-id']).toBe('pay-mockbank');
    expect(seenHeaders['x-pay-mode']).toBe('test');
    await deliver(t);
    expect(t.receiver.bodies().map((b) => [b.reference, b.status])).toEqual([[reference, 'captured']]);
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('captured');
  });

  it('límite: pagar dos veces el mismo QR es idempotente (already_paid y UN solo callback); Bs 0,10 y los escenarios por importe se respetan', async () => {
    await openQr();
    await pay(QR_A);
    const again = await pay(QR_A);
    expect(again.status).toBe(200);
    expect(again.body.already_paid).toBe(true);
    await deliver(t);
    expect(t.receiver.received).toHaveLength(1);

    decoded = { crc_valid: true, amount: '0.10', currency_numeric: '068' }; // Bs 0,10: el importe mínimo que el banco aprueba (centavos 01 = rechazado)
    const tiny = await openQr(10, QR_B);
    expect((await pay(QR_B)).body).toMatchObject({ charge_reference: tiny, amount_minor: 10 });
    // Centavos 05 (callback perdido): el pagador paga pero el callback NUNCA sale; solo la consulta lo revela.
    decoded = { crc_valid: true, amount: '100.05', currency_numeric: '068' };
    const lost = await openQr(10005, QR_C);
    expect((await pay(QR_C)).status).toBe(200);
    t.receiver.received.length = 0;
    await deliver(t);
    expect(t.receiver.bodies().filter((b) => b.reference === lost)).toEqual([]);
    expect((await get(t, `/sandbox/charges/${lost}`)).body.status).toBe('captured');
  });

  it('inválido: CRC malo, moneda ajena, QR sin monto, monto distinto, QR que el banco no conoce, vencido o anulado ⇒ no se paga', async () => {
    const reference = await openQr();
    decoded = { crc_valid: false, amount: '100.00', currency_numeric: '068' };
    expect((await pay(QR_A)).status).toBe(422);
    decoded = { crc_valid: true, amount: '100.00', currency_numeric: '840' };
    expect((await pay(QR_A)).status).toBe(422);
    decoded = { crc_valid: true, amount: null, currency_numeric: '068' };
    expect((await pay(QR_A)).status).toBe(422);
    decoded = { crc_valid: true, amount: '99.99', currency_numeric: '068' };
    expect((await pay(QR_A)).status).toBe(422);
    decoded = { crc_valid: true, amount: '100.00', currency_numeric: '068' };
    const unknown = await pay(QR_B);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('qr_not_registered');
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('pending'); // ninguno de los anteriores pagó
    await post(t, `/sandbox/charges/${reference}/cancel`, {});
    expect((await pay(QR_A)).status).toBe(409);
    expect(t.receiver.received).toHaveLength(0);
    // Vencido
    decoded = { crc_valid: true, amount: '100.00', currency_numeric: '068' };
    await openQr(10000, QR_B);
    t.clock.advance(3_700_000);
    expect((await pay(QR_B)).status).toBe(409);
  });

  it('inválido: pay-qr caído (502 connector_unavailable), pay-qr que responde 422 (no es un QR EMV) o cuerpo sin QR ⇒ no se paga; sin identidad `pay-mockbank` ⇒ 403', async () => {
    const reference = await openQr();
    decoded = { status: 422 };
    expect((await pay(QR_A)).status).toBe(422);
    decoded = { status: 500 };
    expect((await pay(QR_A)).status).toBe(502);
    expect((await request(t.app.getHttpServer()).post('/sandbox/payer/pay').set(asAdmin).send({})).status).toBe(422);
    expect((await request(t.app.getHttpServer()).post('/sandbox/payer/pay').set(asConnectors).send({ qr_payload: QR_A })).status).toBe(403);
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('pending');
  });

  it('sin PAY_QR_URL el pagador no puede decodificar: 500 claro, sin pagar nada', async () => {
    const bare = await createTestApp({ config: { qrUrl: undefined, payerMode: 'manual' } });
    try {
      const body = chargeBody({}, bare.clock);
      await post(bare, '/sandbox/charges', body);
      await request(bare.app.getHttpServer()).put(`/sandbox/charges/${body.reference as string}/qr`).set(asConnectors).send({ payload: QR_A });
      expect((await request(bare.app.getHttpServer()).post('/sandbox/payer/pay').set(asAdmin).send({ qr_payload: QR_A })).status).toBe(500);
      expect((await get(bare, `/sandbox/charges/${body.reference as string}`)).body.status).toBe('pending');
    } finally {
      await bare.close();
    }
  });
});
