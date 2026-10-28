import request from 'supertest';
import { asAdmin, asConnectors, chargeBody, chargeRef, createTestApp, deliver, get, post, refundRef, type TestApp } from './support/app';

// Gate «Idempotencia» (PLAN-MAESTRO §7): cada mutación repetida N veces EN PARALELO deja UN solo efecto. El banco es idempotente por la referencia que manda la pasarela.
// Cinco corridas cada una (un resultado intermitente es un bug hasta demostrar lo contrario).
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const count = async (table: string): Promise<number> => (await t.db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
/** Los pedidos salen YA, todos a la vez (supertest es perezoso: `.then` los dispara). */
const parallel = (n: number, send: (i: number) => request.Test): Promise<request.Response[]> => Promise.all(Array.from({ length: n }, (_, i) => send(i).then((r) => r)));

describe.each([1, 2, 3, 4, 5])('corrida %i', () => {
  it('20 cobros simultáneos con la MISMA referencia ⇒ UN cobro, una sola creación (201), el mismo `bank_reference` y UN callback', async () => {
    const body = chargeBody({ amount_minor: 10000 }, t.clock);
    const responses = await parallel(20, () => request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    expect(new Set(responses.map((r) => r.body.bank_reference)).size).toBe(1);
    expect(await count('mb_charges')).toBe(1);
    expect(await count('mb_callbacks')).toBe(1);
    await deliver(t);
    expect(t.receiver.received).toHaveLength(1);
  });

  it('20 reembolsos simultáneos con la MISMA referencia ⇒ UN reembolso', async () => {
    const charge = chargeBody({ amount_minor: 10000 }, t.clock);
    await post(t, '/sandbox/charges', charge);
    const reference = refundRef();
    const responses = await parallel(20, () => request(t.app.getHttpServer()).post('/sandbox/refunds').set(asConnectors).send({ reference, charge_reference: charge.reference, amount_minor: 3000 }));
    expect(responses.every((r) => r.body.status === 'captured')).toBe(true);
    expect(new Set(responses.map((r) => r.body.bank_reference)).size).toBe(1);
    expect(await count('mb_refunds')).toBe(1);
  });

  it('5 reembolsos DISTINTOS de Bs 30 sobre un cobro de Bs 100 ⇒ exactamente 3 prosperan (nunca se devuelve más de lo cobrado)', async () => {
    const charge = chargeBody({ amount_minor: 10000 }, t.clock);
    await post(t, '/sandbox/charges', charge);
    const responses = await parallel(5, () => request(t.app.getHttpServer()).post('/sandbox/refunds').set(asConnectors).send({ reference: refundRef(), charge_reference: charge.reference, amount_minor: 3000 }));
    expect(responses.filter((r) => r.body.status === 'captured')).toHaveLength(3);
    expect(responses.filter((r) => r.body.status === 'failed')).toHaveLength(2);
    expect((await t.db.pool.query('SELECT sum(amount_minor)::int AS total FROM mb_refunds')).rows[0].total).toBe(9000);
  });

  it('10 transferencias simultáneas con la MISMA referencia ⇒ UNA transferencia (el banco paga una sola vez)', async () => {
    const reference = `po_par${process.pid}:payout:1`;
    const responses = await parallel(10, () => request(t.app.getHttpServer()).post('/sandbox/transfers').set(asConnectors).send({ reference, amount_minor: 250000, destination_ref: 'dest_comercio_0001' }));
    expect(responses.every((r) => r.status === 200 && r.body.status === 'paid')).toBe(true);
    expect(new Set(responses.map((r) => r.body.bank_reference)).size).toBe(1);
    expect(await count('mb_transfers')).toBe(1);
  });

  it('autorización de tarjeta: 10 autorizaciones iguales ⇒ UNA; 10 capturas simultáneas ⇒ UNA captura y UN callback; captura y anulación a la vez ⇒ gana una sola', async () => {
    const reference = chargeRef();
    const auths = await parallel(10, () => request(t.app.getHttpServer()).post('/sandbox/card-authorizations').set(asConnectors).send({ reference, amount_minor: 10000, card_token: 'tok_prueba0001' }));
    expect(auths.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await count('mb_card_auths')).toBe(1);
    const captures = await parallel(10, () => request(t.app.getHttpServer()).post(`/sandbox/card-authorizations/${reference}/capture`).set(asConnectors).send({}));
    expect(captures.every((r) => r.status === 200 && r.body.status === 'captured')).toBe(true);
    expect(await count('mb_callbacks')).toBe(1);

    const race = chargeRef();
    await post(t, '/sandbox/card-authorizations', { reference: race, amount_minor: 10000, card_token: 'tok_prueba0001' });
    const results = await Promise.all([
      request(t.app.getHttpServer()).post(`/sandbox/card-authorizations/${race}/capture`).set(asConnectors).send({}).then((r) => r),
      request(t.app.getHttpServer()).post(`/sandbox/card-authorizations/${race}/void`).set(asConnectors).send({}).then((r) => r),
    ]);
    const final = (await get(t, `/sandbox/card-authorizations/${race}`)).body.status as string;
    expect(['captured', 'voided']).toContain(final);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1); // la otra operación encuentra el estado ya cambiado (409)
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
  });

  it('20 depósitos del pagador con la MISMA referencia son 20 depósitos distintos (así funciona un banco: no hay idempotencia en el depósito), y el pago de un QR concurrente cobra UNA vez', async () => {
    const deposits = await parallel(20, () => request(t.app.getHttpServer()).post('/sandbox/payer/transfer-in').set(asAdmin).send({ reference: 'TRPARALELO01', amount_minor: 100 }));
    expect(deposits.every((r) => r.status === 201)).toBe(true);
    expect(await count('mb_statement_extra')).toBe(20);
  });
});
