import request from 'supertest';
import { XMLParser } from 'fast-xml-parser';
import { asAdmin, asConnectors, chargeBody, chargeRef, createTestApp, deliver, get, post, refundRef, type TestApp } from './support/app';

// Superficie del banco (P4.H4.M2): cobros, QR, reembolsos, transferencias, tarjeta y extracto. Tres niveles: correcto, límite, inválido.
// Toda respuesta se valida contra la propuesta de contrato (`openapi/mockbank-v1.proposal.yaml`).
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const range = () => `from=${new Date(t.clock.now().getTime() - 3_600_000).toISOString()}&to=${new Date(t.clock.now().getTime() + 3_600_000).toISOString()}`;
const contract = (method: string, path: string, status: number, body: unknown) => t.contract.assertResponse({ method, path, status, body });
const QR = '00020101021226280004bank0108ref12345520400005303068540510000.5802BO5911ALOVIDA PAY6011Santa Cruz62070503ABC6304ABCD';

describe('compuerta de modo e identidad (D-28, regla de separación #8)', () => {
  const OPS: Array<[string, (headers: Record<string, string>) => request.Test]> = [
    ['GET /sandbox/probe', (h) => request(t.app.getHttpServer()).get('/sandbox/probe').set(h)],
    ['POST /sandbox/charges', (h) => request(t.app.getHttpServer()).post('/sandbox/charges').set(h).send(chargeBody({}, t.clock) as object)],
    ['GET /sandbox/charges/{r}', (h) => request(t.app.getHttpServer()).get(`/sandbox/charges/${chargeRef()}`).set(h)],
    ['POST /sandbox/transfers', (h) => request(t.app.getHttpServer()).post('/sandbox/transfers').set(h).send({ reference: 'po_x:payout:1', amount_minor: 5000, destination_ref: 'dest_1' })],
    ['GET /sandbox/statement', (h) => request(t.app.getHttpServer()).get(`/sandbox/statement?${range()}`).set(h)],
    ['POST /sandbox/card-authorizations', (h) => request(t.app.getHttpServer()).post('/sandbox/card-authorizations').set(h).send({ reference: chargeRef(), amount_minor: 5000, card_token: 'tok_prueba0001' })],
  ];

  it.each(OPS)('%s: X-Pay-Mode ausente, `live`, inválido o repetido ⇒ 403 SIN efecto', async (_name, send) => {
    for (const mode of [undefined, 'live', 'prod', '', 'TEST', 'test,live']) {
      const headers: Record<string, string> = { 'x-service-id': 'pay-connectors', ...(mode !== undefined && { 'x-pay-mode': mode }) };
      const response = await send(headers);
      expect(response.status).toBe(403);
      expect(response.headers['x-pay-mode']).toBe('sandbox');
    }
    expect((await t.db.pool.query('SELECT (SELECT count(*) FROM mb_charges) + (SELECT count(*) FROM mb_transfers) + (SELECT count(*) FROM mb_card_auths) AS n')).rows[0].n).toBe('0');
  });

  it.each(OPS)('%s: otro servicio (o ninguno) ⇒ 403', async (_name, send) => {
    for (const service of [undefined, 'pay-payments', 'pay-edge', 'pay-mockbank', 'no-es-un-servicio']) {
      const response = await send({ ...(service !== undefined && { 'x-service-id': service }), 'x-pay-mode': 'test' });
      expect(response.status).toBe(403);
    }
  });

  it('el pagador y el administrador solo los llama `pay-mockbank`; el conector NO', async () => {
    for (const path of ['/sandbox/payer/pay', '/sandbox/admin/deliver', '/sandbox/admin/reset']) {
      expect((await request(t.app.getHttpServer()).post(path).set(asConnectors).send({})).status).toBe(403);
    }
  });
});

describe('cobros y QR', () => {
  it('correcto: crear, repetir (idempotente por referencia), consultar y anular; cumple el contrato', async () => {
    const body = chargeBody({ amount_minor: 25010 }, t.clock);
    const first = await post(t, '/sandbox/charges', body);
    expect(first.status).toBe(201);
    contract('POST', '/sandbox/charges', 201, first.body);
    const again = await post(t, '/sandbox/charges', body);
    expect(again.status).toBe(200);
    contract('POST', '/sandbox/charges', 200, again.body);
    expect(again.body.bank_reference).toBe(first.body.bank_reference);
    const found = await get(t, `/sandbox/charges/${body.reference as string}`);
    contract('GET', `/sandbox/charges/${body.reference as string}`, 200, found.body);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_charges')).rows[0].n).toBe(1);
    // Con el pago ya hecho, anular es un conflicto; una referencia aparte, sin pagar (nunca pagado), sí se puede anular.
    expect((await post(t, `/sandbox/charges/${body.reference as string}/cancel`, {})).status).toBe(409);
    const open = chargeBody({ amount_minor: 10008 }, t.clock);
    await post(t, '/sandbox/charges', open);
    const canceled = await post(t, `/sandbox/charges/${open.reference as string}/cancel`, {});
    expect(canceled.body).toEqual({ status: 'canceled' });
    contract('POST', '/sandbox/charges/{reference}/cancel', 200, canceled.body);
    expect((await post(t, `/sandbox/charges/${open.reference as string}/cancel`, {})).body).toEqual({ status: 'canceled' }); // idempotente
    expect((await get(t, `/sandbox/charges/${open.reference as string}`)).body.status).toBe('canceled');
  });

  it('límite: referencia de 10 y de 40 caracteres, importe mínimo (1) y techo; una referencia desconocida da 404 charge_not_found', async () => {
    expect((await post(t, '/sandbox/charges', chargeBody({ reference: `ch_${'a'.repeat(10)}`, amount_minor: 1 }, t.clock))).status).toBe(201);
    expect((await post(t, '/sandbox/charges', chargeBody({ reference: `ch_${'b'.repeat(40)}`, amount_minor: 100_000_000_000 }, t.clock))).status).toBe(201);
    const missing = await get(t, `/sandbox/charges/${chargeRef()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('charge_not_found');
    contract('GET', '/sandbox/charges/{reference}', 404, missing.body);
  });

  it('inválido: campos que faltan, no declarados, moneda, método, importe decimal/negativo/cero/enorme ⇒ 422 sin efecto', async () => {
    const bad = [
      { reference: 'ch_corto' },
      chargeBody({ reference: 'CH_MAYUSCULAS12345' }, t.clock),
      chargeBody({ currency: 'USD' }, t.clock),
      chargeBody({ method: 'cash' }, t.clock),
      chargeBody({ amount_minor: 10.5 }, t.clock),
      chargeBody({ amount_minor: 0 }, t.clock),
      chargeBody({ amount_minor: -5 }, t.clock),
      chargeBody({ amount_minor: 100_000_000_001 }, t.clock),
      chargeBody({ amount_minor: '10000' }, t.clock),
      chargeBody({ expires_at: 'mañana' }, t.clock),
      chargeBody({ extra: 'no declarado' }, t.clock),
    ];
    for (const body of bad) {
      const response = await post(t, '/sandbox/charges', body);
      expect(response.status).toBe(422);
      contract('POST', '/sandbox/charges', 422, response.body);
    }
    expect((await post(t, '/sandbox/charges', [])).status).toBe(422);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_charges')).rows[0].n).toBe(0);
  });

  it('QR: se registra (idempotente), el mismo QR para otro cobro o un QR distinto para el mismo cobro ⇒ 409 qr_conflict', async () => {
    const a = chargeBody({}, t.clock);
    const b = chargeBody({}, t.clock);
    await post(t, '/sandbox/charges', a);
    await post(t, '/sandbox/charges', b);
    const put = (reference: string, payload: string) => request(t.app.getHttpServer()).put(`/sandbox/charges/${reference}/qr`).set(asConnectors).send({ payload });
    const ok = await put(a.reference as string, QR);
    expect(ok.status).toBe(200);
    contract('PUT', '/sandbox/charges/{reference}/qr', 200, ok.body);
    expect((await put(a.reference as string, QR)).status).toBe(200);
    const other = await put(b.reference as string, QR);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('qr_conflict');
    expect((await put(a.reference as string, QR.replace('ABC', 'XYZ'))).status).toBe(409);
    expect((await put(a.reference as string, 'no-es-un-qr')).status).toBe(422);
    expect((await put(chargeRef(), QR)).status).toBe(404);
  });
});

describe('reembolsos', () => {
  const paid = async (amount = 10000) => {
    const body = chargeBody({ amount_minor: amount }, t.clock);
    await post(t, '/sandbox/charges', body);
    return body.reference as string;
  };

  it('correcto: parcial + parcial, idempotente por referencia, consultable; cumple el contrato', async () => {
    const charge = await paid();
    const ref = refundRef();
    const first = await post(t, '/sandbox/refunds', { reference: ref, charge_reference: charge, amount_minor: 4000 });
    expect(first.status).toBe(201);
    contract('POST', '/sandbox/refunds', 201, first.body);
    const repeat = await post(t, '/sandbox/refunds', { reference: ref, charge_reference: charge, amount_minor: 4000 });
    expect(repeat.body.bank_reference).toBe(first.body.bank_reference);
    const found = await get(t, `/sandbox/refunds/${ref}`);
    expect(found.body).toEqual({ bank_reference: first.body.bank_reference, status: 'captured' });
    contract('GET', '/sandbox/refunds/{reference}', 200, found.body);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_refunds')).rows[0].n).toBe(1);
  });

  it('límite: reembolsar justo el total pasa; un centavo de más lo rechaza el banco (failed) y NO guarda la referencia', async () => {
    const charge = await paid();
    expect((await post(t, '/sandbox/refunds', { reference: refundRef(), charge_reference: charge, amount_minor: 10000 })).body.status).toBe('captured');
    const over = refundRef();
    const rejected = await post(t, '/sandbox/refunds', { reference: over, charge_reference: charge, amount_minor: 1 });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'failed', failure_code: 'validation_failed' });
    contract('POST', '/sandbox/refunds', 200, rejected.body);
    const missing = await get(t, `/sandbox/refunds/${over}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('refund_not_found'); // el 404 EXPLÍCITO: el banco no lo tiene
    contract('GET', '/sandbox/refunds/{reference}', 404, missing.body);
  });

  it('inválido: cobro desconocido 404, cobro sin pagar 409, referencia mal formada 422', async () => {
    expect((await post(t, '/sandbox/refunds', { reference: refundRef(), charge_reference: chargeRef(), amount_minor: 100 })).status).toBe(404);
    const unpaid = chargeBody({ amount_minor: 10008 }, t.clock);
    await post(t, '/sandbox/charges', unpaid);
    expect((await post(t, '/sandbox/refunds', { reference: refundRef(), charge_reference: unpaid.reference, amount_minor: 100 })).status).toBe(409);
    expect((await post(t, '/sandbox/refunds', { reference: 'x', charge_reference: 'y', amount_minor: 100 })).status).toBe(422);
  });
});

describe('transferencias salientes', () => {
  const order = (cents: number, ref = `po_${process.pid}${cents}:payout:1`) => post(t, '/sandbox/transfers', { reference: ref, amount_minor: 250000 + cents, destination_ref: 'dest_comercio_0001' });

  it('correcto (00): pagada, idempotente por referencia (no paga dos veces) y consultable', async () => {
    const ref = `po_${process.pid}ok:payout:1`;
    const first = await order(0, ref);
    expect(first.body.status).toBe('paid');
    contract('POST', '/sandbox/transfers', 200, first.body);
    const again = await order(0, ref);
    expect(again.body.bank_reference).toBe(first.body.bank_reference);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_transfers')).rows[0].n).toBe(1);
    const found = await get(t, `/sandbox/transfers/${encodeURIComponent(ref)}`);
    expect(found.body.status).toBe('paid');
    contract('GET', '/sandbox/transfers/{reference}', 200, found.body);
  });

  it('límite: 01 fallida rejected_by_bank · 02 en tránsito hasta el retraso · 08 en tránsito para siempre · 06 banco caído (nada se registra)', async () => {
    expect((await order(1)).body).toMatchObject({ status: 'failed', failure_code: 'rejected_by_bank' });
    const delayedRef = `po_${process.pid}d:payout:1`;
    expect((await order(2, delayedRef)).body.status).toBe('in_transit');
    t.clock.advance(t.config.delayMs - 1);
    expect((await get(t, `/sandbox/transfers/${encodeURIComponent(delayedRef)}`)).body.status).toBe('in_transit');
    t.clock.advance(1);
    expect((await get(t, `/sandbox/transfers/${encodeURIComponent(delayedRef)}`)).body.status).toBe('paid');
    const forever = `po_${process.pid}f:payout:1`;
    expect((await order(8, forever)).body.status).toBe('in_transit');
    t.clock.advance(86_400_000);
    expect((await get(t, `/sandbox/transfers/${encodeURIComponent(forever)}`)).body.status).toBe('in_transit');
    const down = await order(6);
    expect(down.status).toBe(503);
    expect((await get(t, `/sandbox/transfers/${encodeURIComponent(`po_${process.pid}6:payout:1`)}`)).body.code).toBe('transfer_not_found');
  });

  it('ambiguas (la orden SE EJECUTA y la respuesta se pierde): 07 sin respuesta · 17 proxy 502 con HTML · 27 socket reseteado', async () => {
    const run = (cents: number, ref: string) => request(t.app.getHttpServer()).post('/sandbox/transfers').set(asConnectors).send({ reference: ref, amount_minor: 250000 + cents, destination_ref: 'dest_1' }).timeout({ response: 150, deadline: 1500 });
    const r17 = `po_${process.pid}17:payout:1`;
    const proxy = await request(t.app.getHttpServer()).post('/sandbox/transfers').set(asConnectors).send({ reference: r17, amount_minor: 250017, destination_ref: 'dest_1' });
    expect(proxy.status).toBe(502);
    expect(proxy.headers['content-type']).toMatch(/text\/html/);
    expect(proxy.text).toContain('502 Bad Gateway');
    expect(proxy.body.code).toBeUndefined(); // NO es el cuerpo de error del banco: no prueba que no se ejecutó
    await expect(run(7, `po_${process.pid}07:payout:1`)).rejects.toBeDefined();
    await expect(run(27, `po_${process.pid}27:payout:1`)).rejects.toBeDefined();
    // En las tres la orden quedó ejecutada: la consulta la encuentra y repetir la orden no paga otra vez.
    for (const r of [r17, `po_${process.pid}07:payout:1`, `po_${process.pid}27:payout:1`]) expect((await get(t, `/sandbox/transfers/${encodeURIComponent(r)}`)).body.status).toBe('paid');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_transfers')).rows[0].n).toBe(3);
  });

  it('inválido: referencia vacía o enorme, destino que parece un número de cuenta con espacios, importe 0 ⇒ 422', async () => {
    for (const body of [
      { reference: '', amount_minor: 100, destination_ref: 'd' },
      { reference: 'r'.repeat(201), amount_minor: 100, destination_ref: 'd' },
      { reference: 'r', amount_minor: 100, destination_ref: 'cuenta 1234 5678' },
      { reference: 'r', amount_minor: 0, destination_ref: 'd' },
      { reference: 'r', amount_minor: 100, destination_ref: 'd', cuenta: '123' },
    ]) {
      expect((await post(t, '/sandbox/transfers', body)).status).toBe(422);
    }
  });
});

describe('tarjeta: autorización → captura | anulación (solo token de prueba; NUNCA un PAN)', () => {
  const auth = (over: Record<string, unknown> = {}) => post(t, '/sandbox/card-authorizations', { reference: chargeRef(), amount_minor: 10000, card_token: 'tok_prueba0001', ...over });

  it('correcto: autoriza, captura (callback captured) y repetir la captura no duplica nada', async () => {
    const reference = chargeRef();
    const created = await auth({ reference });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'authorized', amount_minor: 10000, captured_minor: 0 });
    contract('POST', '/sandbox/card-authorizations', 201, created.body);
    const captured = await post(t, `/sandbox/card-authorizations/${reference}/capture`, {});
    expect(captured.body).toMatchObject({ status: 'captured', captured_minor: 10000 });
    contract('POST', '/sandbox/card-authorizations/{reference}/capture', 200, captured.body);
    expect((await post(t, `/sandbox/card-authorizations/${reference}/capture`, {})).body.status).toBe('captured');
    await deliver(t);
    expect(t.receiver.bodies().map((b) => b.status)).toEqual(['captured']);
    expect((await get(t, `/sandbox/card-authorizations/${reference}`)).body.status).toBe('captured');
    expect((await auth({ reference })).status).toBe(200); // misma referencia: la misma autorización
  });

  it('límite: captura PARCIAL (la mitad), captura de más ⇒ 409, anular una capturada ⇒ 409, anular una autorizada es idempotente', async () => {
    const half = chargeRef();
    await auth({ reference: half });
    const partial = await post(t, `/sandbox/card-authorizations/${half}/capture`, { amount_minor: 5000 });
    expect(partial.body).toMatchObject({ status: 'captured', captured_minor: 5000 });
    expect((await post(t, `/sandbox/card-authorizations/${half}/void`, {})).status).toBe(409);
    const over = chargeRef();
    await auth({ reference: over });
    expect((await post(t, `/sandbox/card-authorizations/${over}/capture`, { amount_minor: 10001 })).status).toBe(409);
    const voided = await post(t, `/sandbox/card-authorizations/${over}/void`, {});
    expect(voided.body.status).toBe('voided');
    contract('POST', '/sandbox/card-authorizations/{reference}/void', 200, voided.body);
    expect((await post(t, `/sandbox/card-authorizations/${over}/void`, {})).body.status).toBe('voided');
    expect((await post(t, `/sandbox/card-authorizations/${over}/capture`, {})).status).toBe(409); // anulada: no se captura
    await deliver(t);
    expect(t.receiver.bodies().map((b) => b.status)).toEqual(['captured', 'canceled']);
  });

  it('escenarios por importe: 01 declined (card_declined, no se captura) · 06 caído 503 · 07 se autoriza pero la conexión se corta', async () => {
    const declined = chargeRef();
    expect((await auth({ reference: declined, amount_minor: 10001 })).body).toMatchObject({ status: 'declined', failure_code: 'card_declined' });
    expect((await post(t, `/sandbox/card-authorizations/${declined}/capture`, {})).status).toBe(409);
    expect((await auth({ amount_minor: 10006 })).status).toBe(503);
    const cut = chargeRef();
    await expect(request(t.app.getHttpServer()).post('/sandbox/card-authorizations').set(asConnectors).send({ reference: cut, amount_minor: 10007, card_token: 'tok_prueba0001' }).timeout({ response: 150, deadline: 1500 })).rejects.toBeDefined();
    expect((await get(t, `/sandbox/card-authorizations/${cut}`)).body.status).toBe('authorized');
  });

  it('inválido: un PAN en `card_token` (con o sin separadores) o un token mal formado ⇒ 422 que NO repite el valor; referencia desconocida ⇒ 404', async () => {
    for (const token of ['4111111111111111', '4111 1111 1111 1111', 'tok_4111111111111111', 'tok_corto', '', 5]) {
      const response = await auth({ card_token: token });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain('4111');
    }
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_card_auths')).rows[0].n).toBe(0);
    expect((await get(t, `/sandbox/card-authorizations/${chargeRef()}`)).status).toBe(404);
    expect((await auth({ extra: 1 })).status).toBe(422);
  });
});

describe('extracto: JSON, CSV y camt.053', () => {
  it('correcto: las tres formas traen las mismas líneas (cobro + línea ajena inyectada) y el CSV neutraliza fórmulas', async () => {
    const body = chargeBody({ amount_minor: 12345 }, t.clock);
    await post(t, '/sandbox/charges', body);
    const injected = await request(t.app.getHttpServer()).post('/sandbox/admin/statement-lines').set(asAdmin).send({ direction: 'credit', amount_minor: 999, booked_at: t.clock.now().toISOString(), description: '=HYPERLINK("http://x")' });
    expect(injected.status).toBe(201);
    const json = await get(t, `/sandbox/statement?${range()}`);
    expect(json.body.data).toHaveLength(2);
    contract('GET', '/sandbox/statement', 200, json.body);

    const csv = await get(t, `/sandbox/statement?${range()}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('bank_reference,our_reference,direction,amount,currency,value_date,booked_at,description');
    expect(lines).toHaveLength(3);
    expect(csv.text).toContain('123.45');
    expect(csv.text).toContain("\"'=HYPERLINK(\"\"http://x\"\")\""); // la fórmula quedó neutralizada

    const camt = await get(t, `/sandbox/statement?${range()}&format=camt053`);
    expect(camt.headers['content-type']).toMatch(/application\/xml/);
    const doc = new XMLParser({ ignoreAttributes: false }).parse(camt.text) as { Document: { '@_xmlns': string; BkToCstmrStmt: { Stmt: { Acct: { Ownr: { Nm: string } }; Ntry: Array<{ Amt: { '#text': string | number; '@_Ccy': string }; CdtDbtInd: string; NtryDtls: { TxDtls: { Refs?: { EndToEndId: string } } } }> } } } };
    expect(doc.Document['@_xmlns']).toBe('urn:iso:std:iso:20022:tech:xsd:camt.053.001.02');
    expect(doc.Document.BkToCstmrStmt.Stmt.Acct.Ownr.Nm).toContain('SANDBOX');
    const entries = doc.Document.BkToCstmrStmt.Stmt.Ntry;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => String(e.Amt['#text'])).sort()).toEqual(['123.45', '9.99']);
    expect(entries.every((e) => e.Amt['@_Ccy'] === 'BOB' && e.CdtDbtInd === 'CRDT')).toBe(true);
    expect(entries.find((e) => e.NtryDtls.TxDtls.Refs)?.NtryDtls.TxDtls.Refs?.EndToEndId).toBe(body.reference);
  });

  it('límite: rango vacío ⇒ extracto vacío válido en las tres formas; los bordes del rango son inclusivos', async () => {
    const body = chargeBody({ amount_minor: 10000 }, t.clock);
    const at = t.clock.now();
    await post(t, '/sandbox/charges', body);
    const exact = `from=${at.toISOString()}&to=${at.toISOString()}`;
    expect((await get(t, `/sandbox/statement?${exact}`)).body.data).toHaveLength(1);
    const empty = `from=${new Date(at.getTime() + 1000).toISOString()}&to=${new Date(at.getTime() + 2000).toISOString()}`;
    expect((await get(t, `/sandbox/statement?${empty}`)).body.data).toEqual([]);
    expect((await get(t, `/sandbox/statement?${empty}&format=csv`)).text.trim().split('\r\n')).toHaveLength(1);
    expect((await get(t, `/sandbox/statement?${empty}&format=camt053`)).text).not.toContain('<Ntry>');
  });

  it('inválido: rango invertido, fechas rotas o formato desconocido ⇒ 422', async () => {
    const now = t.clock.now();
    for (const q of ['from=hoy&to=mañana', `from=${new Date(now.getTime() + 1000).toISOString()}&to=${now.toISOString()}`, `${range()}&format=pdf`, '']) {
      expect((await get(t, `/sandbox/statement?${q}`)).status).toBe(422);
    }
  });
});

describe('banco caído a la fuerza (probar salud y ruteo)', () => {
  it('con down=true TODA operación del banco da 503 bank_unavailable y la sonda también; al levantarlo vuelve todo', async () => {
    const body = chargeBody({}, t.clock);
    await post(t, '/sandbox/charges', body);
    expect((await request(t.app.getHttpServer()).put('/sandbox/admin/down').set(asAdmin).send({ down: true })).body).toEqual({ down: true });
    for (const response of [await get(t, '/sandbox/probe'), await get(t, `/sandbox/charges/${body.reference as string}`), await post(t, '/sandbox/charges', chargeBody({}, t.clock)), await get(t, `/sandbox/statement?${range()}`)]) {
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('bank_unavailable');
    }
    await request(t.app.getHttpServer()).put('/sandbox/admin/down').set(asAdmin).send({ down: false });
    expect((await get(t, '/sandbox/probe')).body).toEqual({ status: 'ok' });
    expect((await request(t.app.getHttpServer()).put('/sandbox/admin/down').set(asAdmin).send({ down: 'si' })).status).toBe(422);
  });
});
