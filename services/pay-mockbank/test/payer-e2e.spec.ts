import { join } from 'node:path';
import request from 'supertest';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { runCli } from '../src/cli-main';
import { asConnectors, chargeRef, createTestApp, deliver, get, post, REPO, type TestApp } from './support/app';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// Pagador simulado (P4.H4.M4) contra el pay-qr REAL (proceso `dist/main.js` de pay-qr, esquema aislado): se emite un QR de verdad, el banco lo registra,
// y `mockbank pay <qr>` lo decodifica con pay-qr y lo paga. Nada de stubs en este camino.
const url = new URL(TEST_DATABASE_URL);
const QR_SQL = [join(REPO, 'services/pay-qr/sql/ddl.sql')];
let qrDb: IsolatedDatabase;
let qr: Started;
let qrBase = '';
let t: TestApp;

beforeAll(async () => {
  buildService('pay-qr');
  qrDb = await createIsolatedDatabase(QR_SQL);
  const port = await freePort();
  qrBase = `http://127.0.0.1:${port}`;
  qr = startService('pay-qr', {
    DB_HOST: url.hostname,
    DB_PORT: url.port || '5432',
    DB_NAME: url.pathname.slice(1),
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
    PGOPTIONS: `-c search_path=${qrDb.schema}`,
    PORT: String(port),
    PAY_MODE: 'sandbox',
    QR_ACCOUNT_GUID: 'e2e.sandbox.guid',
  });
  const ready = await until(async () => ((await fetch(`${qrBase}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, qr.exited);
  if (!ready) throw new Error(`pay-qr no llegó a estar listo:\n${qr.output()}`);
  t = await createTestApp({ config: { qrUrl: qrBase, payerMode: 'manual' } });
}, 240_000);
afterAll(async () => {
  await t.close();
  await stop(qr);
  await qrDb.drop();
});

/** Emite un QR dinámico de verdad en pay-qr (como lo haría pay-connectors) y lo registra en el banco. */
async function issue(amountMinor: number) {
  const reference = chargeRef();
  await post(t, '/sandbox/charges', { reference, amount_minor: amountMinor, currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const issued = await fetch(`${qrBase}/qr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test', 'idempotency-key': `qr-${reference}`, connection: 'close' },
    body: JSON.stringify({ kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'ALOVIDA PAY', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: amountMinor, payment_intent_id: `pi_e2e${reference.slice(3)}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
  });
  expect(issued.status).toBe(201);
  const { payload } = (await issued.json()) as { payload: string };
  await request(t.app.getHttpServer()).put(`/sandbox/charges/${reference}/qr`).set(asConnectors).send({ payload });
  return { reference, payload };
}

async function cli(argv: string[]) {
  const server = t.app.getHttpServer().address() as { port: number };
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { env: { MOCKBANK_URL: `http://127.0.0.1:${server.port}` }, fetchImpl: fetch, out: (x) => out.push(x), err: (x) => err.push(x) });
  return { code, out: out.join(''), err: err.join('') };
}

describe('mockbank pay <qr> con pay-qr real', () => {
  it('correcto: un QR emitido por pay-qr se paga desde la CLI, el cobro queda cobrado y sale UN callback firmado', async () => {
    await t.reset();
    const { reference, payload } = await issue(10000);
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('pending'); // modo manual: nadie pagó
    const result = await cli(['pay', payload]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ charge_reference: reference, status: 'captured', amount_minor: 10000, already_paid: false });
    await deliver(t);
    expect(t.receiver.bodies().map((b) => [b.reference, b.status])).toEqual([[reference, 'captured']]);
  });

  it('límite: pagar el mismo QR otra vez no cobra dos veces; el escenario por importe (05, callback perdido) se respeta', async () => {
    await t.reset();
    const { payload } = await issue(10000);
    await cli(['pay', payload]);
    expect(JSON.parse((await cli(['pay', payload])).out).already_paid).toBe(true);
    await deliver(t);
    expect(t.receiver.received).toHaveLength(1);
    t.receiver.received.length = 0;
    const lost = await issue(10005);
    expect((await cli(['pay', lost.payload])).code).toBe(0);
    await deliver(t);
    expect(t.receiver.received).toHaveLength(0);
    expect((await get(t, `/sandbox/charges/${lost.reference}`)).body.status).toBe('captured');
  });

  it('inválido: un QR con el CRC alterado (pay-qr lo detecta) o que no es EMV no se paga; el cobro sigue pendiente', async () => {
    await t.reset();
    const { reference, payload } = await issue(10000);
    const tampered = `${payload.slice(0, -4)}${payload.endsWith('0000') ? '1111' : '0000'}`;
    const crc = await cli(['pay', tampered]);
    expect(crc.code).toBe(1);
    expect(crc.err).toContain('HTTP 422');
    const junk = await cli(['pay', 'esto-no-es-un-qr-emv-0000000000']);
    expect(junk.code).toBe(1);
    expect((await get(t, `/sandbox/charges/${reference}`)).body.status).toBe('pending');
  });
});
