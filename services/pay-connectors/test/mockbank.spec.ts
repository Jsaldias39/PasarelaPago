import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { HttpQrClient } from '../src/connectors/qr-http.client';
import { HealthService } from '../src/core/health.service';
import { PollerService } from '../src/core/poller.service';
import { StatementsService } from '../src/core/statements.service';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, REPO, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// Capa sandbox (D-26, P4.H4): el conector `mock` y la fuente de transferencias hablan por HTTP con el servicio REAL `pay-mockbank` (proceso
// `dist/main.js`, esquema propio aislado) y este servicio recibe sus callbacks firmados de verdad. Nada de dobles en el cable.
const url = new URL(TEST_DATABASE_URL);
const SECRET = process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET as string;
const dbEnv = { DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) };
const asAdmin = { 'x-service-id': 'pay-mockbank' };

const databases: IsolatedDatabase[] = [];
const processes: Started[] = [];
const apps: TestApp[] = [];
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;

interface Bank {
  readonly started: Started;
  readonly base: string;
  readonly db: IsolatedDatabase;
}

/** Levanta el pay-mockbank real. `callbackPort` es el del servicio que recibe los callbacks. */
async function startBank(port: number, options: { callbackPort?: number; secret?: string; payerMode?: 'auto' | 'manual'; deliveryMs?: number; hangMs?: number; delayMs?: number; qrUrl?: string } = {}): Promise<Bank> {
  const db = await createIsolatedDatabase([join(REPO, 'services/pay-mockbank/sql/001_mockbank.sql')]);
  databases.push(db);
  const started = startService(
    {
      ...dbEnv,
      PGOPTIONS: `-c search_path=${db.schema}`,
      PORT: String(port),
      PAY_MODE: 'sandbox',
      MOCKBANK_WEBHOOK_SECRET: options.secret ?? SECRET,
      ...(options.callbackPort !== undefined && { MOCKBANK_CALLBACK_URL: `http://127.0.0.1:${options.callbackPort}/callbacks/mock` }),
      MOCKBANK_DELIVERY_INTERVAL_MS: String(options.deliveryMs ?? 50),
      MOCKBANK_PAYER_MODE: options.payerMode ?? 'auto',
      MOCKBANK_HANG_MS: String(options.hangMs ?? 1500),
      MOCKBANK_DELAY_MS: String(options.delayMs ?? 400),
      ...(options.qrUrl && { PAY_QR_URL: options.qrUrl }),
    },
    'pay-mockbank',
  );
  processes.push(started);
  const base = `http://127.0.0.1:${port}`;
  const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, started.exited);
  if (!ready) throw new Error(`pay-mockbank no llegó a estar listo:\n${started.output()}`);
  return { started, base, db };
}

const portOf = (t: TestApp): number => (t.app.getHttpServer().address() as { port: number }).port;

/** El servicio de conectores con su banco apuntando a `bankPort`, y el banco apuntando de vuelta a este servicio. */
async function pair(options: { payerMode?: 'auto' | 'manual'; secret?: string; deliveryMs?: number; qrUrl?: string } = {}): Promise<{ t: TestApp; bank: Bank }> {
  const bankPort = await freePort();
  const t = await createTestApp({
    config: { mockbankUrl: `http://127.0.0.1:${bankPort}`, mockbankTimeoutMs: 400, mockPumpIntervalMs: 0, poller: { intervalMs: 0, minAgeMs: 1000, baseBackoffMs: 30_000, maxBackoffMs: 600_000, batchSize: 50 } },
    ...(options.qrUrl && { qr: new HttpQrClient(options.qrUrl) }),
  });
  apps.push(t);
  const bank = await startBank(bankPort, { callbackPort: portOf(t), ...options });
  return { t, bank };
}

beforeAll(async () => {
  buildService('pay-mockbank');
  validateEvent = await loadEventValidator();
}, 240_000);
afterAll(async () => {
  await Promise.all(processes.map(stop));
  for (const t of apps) await t.close();
  for (const db of databases) await db.drop();
});

const charge = (t: TestApp, over: Record<string, unknown> = {}, key = uniqueKey()) => post(t.app, '/charges', chargeBody(over, t.clock), asPayments, key);
const statusOf = async (t: TestApp, id: string) => (await get(t.app, `/charges/${id}`)).body.status as string;
const waitStatus = (t: TestApp, id: string, wanted: string) => until(async () => ((await statusOf(t, id)) === wanted ? true : undefined), 20_000);
const callbackRows = async (t: TestApp, id: string) => (await t.db.pool.query('SELECT status, result, observed_via FROM connector_callback_events WHERE charge_id = $1 ORDER BY id', [id])).rows;
const events = (t: TestApp) => outboxEvents(t.db.pool, 'connector.transaction.status_changed');

describe('cobro QR de punta a punta contra el pay-mockbank real (E1)', () => {
  let t: TestApp;
  let bank: Bank;
  beforeAll(async () => {
    ({ t, bank } = await pair());
  }, 120_000);
  beforeEach(async () => {
    await t.reset();
    await request(bank.base).post('/sandbox/admin/reset').set(asAdmin);
  });

  it('00 aprobado: el banco real entrega el callback FIRMADO, este servicio lo verifica y el cobro queda cobrado (un solo evento válido)', async () => {
    const created = await charge(t, { amount_minor: 10000 });
    expect(created.status).toBe(201);
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: created.body });
    expect(await waitStatus(t, created.body.id, 'succeeded')).toBe(true);
    expect(await callbackRows(t, created.body.id)).toEqual([{ status: 'captured', result: 'applied', observed_via: 'callback' }]);
    const list = await events(t);
    expect(list).toHaveLength(1);
    expect(validateEvent(MESSAGES.status, list[0]?.envelope)).toEqual([]);
    expect(list[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'callback', amount_minor: 10000, connector: 'mock' });
  });

  it('03 duplicado ×3 y 04 fuera de orden: los callbacks reales se absorben sin duplicar el evento ni retroceder el estado', async () => {
    const dup = await charge(t, { amount_minor: 10003 });
    expect(await waitStatus(t, dup.body.id, 'succeeded')).toBe(true);
    const ooo = await charge(t, { amount_minor: 10004 });
    expect(await waitStatus(t, ooo.body.id, 'succeeded')).toBe(true);
    await until(async () => ((await callbackRows(t, dup.body.id)).length === 3 && (await callbackRows(t, ooo.body.id)).length === 2 ? true : undefined), 20_000);
    expect((await callbackRows(t, dup.body.id)).map((r) => r.result).sort()).toEqual(['applied', 'duplicate', 'duplicate']);
    expect((await callbackRows(t, ooo.body.id)).map((r) => r.status)).toContain('captured');
    expect(await statusOf(t, ooo.body.id)).toBe('succeeded'); // `authorized` tardío NO la baja
    expect((await events(t)).filter((e) => (e.envelope.data as { charge_id?: string }).charge_id === dup.body.id)).toHaveLength(1);
  });

  it('05 callback perdido: el banco real no avisa nunca y el poller (consulta de estado por HTTP) lo cobra', async () => {
    const created = await charge(t, { amount_minor: 10005 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf(t, created.body.id)).toBe('requires_action');
    expect(await t.app.get(PollerService).tick()).toEqual({ examined: 0, changed: 0, failed: 0 }); // todavía no cumplió la edad mínima
    t.clock.advance(1001);
    expect(await t.app.get(PollerService).tick()).toEqual({ examined: 1, changed: 1, failed: 0 });
    expect(await statusOf(t, created.body.id)).toBe('succeeded');
    expect(await callbackRows(t, created.body.id)).toEqual([{ status: 'captured', result: 'applied', observed_via: 'status_inquiry' }]);
  });

  it('01 rechazado: failed con card_declined sin callbacks; 08 nunca pagado: el poller lo da por vencido al llegar expires_at', async () => {
    const declined = await charge(t, { amount_minor: 10001 });
    expect(declined.body.status).toBe('failed');
    expect(declined.body.failure_code).toBe('card_declined');
    const never = await charge(t, { amount_minor: 10008, expires_at: new Date(t.clock.now().getTime() + 120_000).toISOString() });
    t.clock.advance(1001);
    await t.app.get(PollerService).tick();
    expect(await statusOf(t, never.body.id)).toBe('requires_action');
    t.clock.advance(120_000);
    await until(async () => ((await t.app.get(PollerService).tick()).changed > 0 ? true : undefined), 5000);
    expect(await statusOf(t, never.body.id)).toBe('failed');
  });

  it('07 timeout ambiguo: el cobro SE CREÓ en el banco; el reintento con la MISMA referencia no crea otro y el cobro termina cobrado', async () => {
    const created = await charge(t, { amount_minor: 10007 });
    expect(created.status).toBe(201); // el reintento interno devolvió el mismo cobro del banco
    expect(await waitStatus(t, created.body.id, 'succeeded')).toBe(true);
    const attempts = await t.db.pool.query("SELECT outcome FROM connector_api_attempts WHERE subject_id = $1 AND operation = 'create_charge' ORDER BY id", [created.body.id]);
    expect(attempts.rows.map((r) => r.outcome)).toEqual(['timeout', 'ok']);
    const bankCount = await bank.db.pool.query('SELECT count(*)::int AS n FROM mb_charges');
    expect(bankCount.rows[0].n).toBe(1);
  });

  it('06 banco caído: 502 connector_unavailable, no se marca ambiguo (seguro reintentar) y el banco no recibió nada', async () => {
    const response = await charge(t, { amount_minor: 10006 });
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('connector_unavailable');
    expect((await t.db.pool.query('SELECT ambiguous FROM connector_charges')).rows[0].ambiguous).toBe(false);
    expect((await bank.db.pool.query('SELECT count(*)::int AS n FROM mb_charges')).rows[0].n).toBe(0);
  });

  it('banco apagado del todo (conexión rechazada): 502 y NO ambiguo (nada se envió), así que es seguro reintentar', async () => {
    // Se apunta el servicio a un puerto sin nadie escuchando.
    const lonely = await createTestApp({ config: { mockbankUrl: `http://127.0.0.1:${await freePort()}`, mockbankTimeoutMs: 400, mockPumpIntervalMs: 0 } });
    apps.push(lonely);
    const first = await post(lonely.app, '/charges', chargeBody({}, lonely.clock), asPayments, uniqueKey());
    expect(first.status).toBe(502);
    expect(first.body.code).toBe('connector_unavailable');
    expect((await lonely.db.pool.query('SELECT ambiguous, provider_reference FROM connector_charges')).rows[0]).toMatchObject({ ambiguous: false, provider_reference: null });
  });

  it('salud: la sonda por HTTP ve al banco arriba y, con el interruptor de «caído», lo marca degradado (y vuelve a arriba al levantarlo)', async () => {
    const health = t.app.get(HealthService);
    await health.probeAll();
    expect(((await get(t.app, '/connectors/health', asPayments)).body.data as Array<{ connector: string; status: string }>).find((h) => h.connector === 'mock')?.status).toBe('up');
    await request(bank.base).put('/sandbox/admin/down').set(asAdmin).send({ down: true });
    await health.probeAll();
    expect(((await get(t.app, '/connectors/health', asPayments)).body.data as Array<{ connector: string; status: string }>).find((h) => h.connector === 'mock')?.status).toBe('degraded');
    await request(bank.base).put('/sandbox/admin/down').set(asAdmin).send({ down: false });
    await health.probeAll();
    expect(((await get(t.app, '/connectors/health', asPayments)).body.data as Array<{ connector: string; status: string }>).find((h) => h.connector === 'mock')?.status).toBe('up');
  });
});

describe('autenticidad del callback entre los dos servicios REALES', () => {
  it('un banco con OTRO secreto: este servicio rechaza todos sus callbacks (401, nada se aplica) y el cobro solo se resuelve por consulta de estado', async () => {
    const { t, bank } = await pair({ secret: 'whsec_b3Ryby1zZWNyZXRvLWRpc3RpbnRvLTAwMDAwMDAwMDA=' });
    const created = await charge(t, { amount_minor: 10000 });
    const delivered = await until(async () => ((await bank.db.pool.query('SELECT max(attempts)::int AS n FROM mb_callbacks')).rows[0].n >= 1 ? true : undefined), 20_000);
    expect(delivered).toBe(true); // el banco lo intentó
    expect(await statusOf(t, created.body.id)).toBe('requires_action'); // y este servicio no lo aplicó
    expect(await callbackRows(t, created.body.id)).toEqual([]);
    expect((await bank.db.pool.query('SELECT count(*)::int AS n FROM mb_callbacks WHERE delivered_at IS NOT NULL')).rows[0].n).toBe(0);
    t.clock.advance(1001);
    expect((await t.app.get(PollerService).tick()).changed).toBe(1);
    expect(await statusOf(t, created.body.id)).toBe('succeeded');
  }, 120_000);
});

describe('reembolso, transferencia saliente y extracto contra el banco real', () => {
  let t: TestApp;
  let bank: Bank;
  beforeAll(async () => {
    ({ t, bank } = await pair());
  }, 120_000);
  beforeEach(async () => {
    await t.reset();
    await request(bank.base).post('/sandbox/admin/reset').set(asAdmin);
  });

  it('reembolso parcial por el banco real, idempotente por referencia, consultable con GET /refunds', async () => {
    const created = await charge(t, { amount_minor: 10000 });
    expect(await waitStatus(t, created.body.id, 'succeeded')).toBe(true);
    const key = uniqueKey();
    const refund = await post(t.app, `/charges/${created.body.id}/refunds`, { amount_minor: 4000 }, asPayments, key);
    expect(refund.status).toBe(201);
    const again = await post(t.app, `/charges/${created.body.id}/refunds`, { amount_minor: 4000 }, asPayments, key);
    expect(again.body.id).toBe(refund.body.id);
    expect((await bank.db.pool.query('SELECT count(*)::int AS n FROM mb_refunds')).rows[0].n).toBe(1);
    const found = await get(t.app, `/refunds/${refund.body.id}?refresh=true`, asPayments);
    expect(found.status).toBe(200);
  });

  it('transferencia saliente: pagada, idempotente (el banco paga UNA vez); 01 fallida rejected_by_bank; consulta GET /transfers/{reference}', async () => {
    const order = (over: Record<string, unknown>, key = uniqueKey()) => post(t.app, '/transfers', { business_ref: `po_mb${process.pid}${Math.floor(Math.random() * 1e6)}:payout`, attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: 'dest_comercio_0001', ...over }, asSettlement, key);
    const same = { business_ref: `po_mbsame${process.pid}:payout` };
    const paid = await order(same);
    expect(paid.body.status).toBe('paid');
    await order(same);
    expect((await bank.db.pool.query('SELECT count(*)::int AS n FROM mb_transfers')).rows[0].n).toBe(1);
    const failed = await order({ amount_minor: 250001 });
    expect(failed.body.status).toBe('failed');
    expect(failed.body.failure_code).toBe('rejected_by_bank');
    const found = await get(t.app, `/transfers/${encodeURIComponent(paid.body.reference as string)}`, asSettlement);
    expect(found.body.status).toBe('paid');
  });

  it('extracto del banco real: el cobro aparece con su `payment_intent_id`; el escenario 09 deja UNA excepción amount_mismatch', async () => {
    const ok = await charge(t, { amount_minor: 10000 });
    const mismatch = await charge(t, { amount_minor: 10009 });
    expect(await waitStatus(t, ok.body.id, 'succeeded')).toBe(true);
    expect(await waitStatus(t, mismatch.body.id, 'succeeded')).toBe(true);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const statement = await get(t.app, `/statements?connector=mock&from=${from}&to=${to}`, asSettlement);
    expect(statement.status).toBe(200);
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 200, body: statement.body });
    const pi = async (id: string) => (await t.db.pool.query('SELECT payment_intent_id FROM connector_charges WHERE id = $1', [id])).rows[0].payment_intent_id as string;
    const line = (id: string) => statement.body.data.find((l: { charge_id: string }) => l.charge_id === id);
    expect(line(ok.body.id)).toMatchObject({ amount_minor: 10000, payment_intent_id: await pi(ok.body.id) });
    expect(line(mismatch.body.id)).toMatchObject({ amount_minor: 10009 - 100, payment_intent_id: await pi(mismatch.body.id) });
    const summary = await t.app.get(StatementsService).reconcile('mock', { from: new Date(from), to: new Date(to) });
    expect(summary).toMatchObject({ lines: 2, matched: 2, exceptions: 1 });
    expect((await t.db.pool.query('SELECT kind, charge_id FROM statement_exceptions')).rows).toEqual([{ kind: 'amount_mismatch', charge_id: mismatch.body.id }]);
  });
});

describe('transferencia bancaria del pagador (E8) contra el banco real', () => {
  let t: TestApp;
  let bank: Bank;
  beforeAll(async () => {
    ({ t, bank } = await pair());
  }, 120_000);
  beforeEach(async () => {
    await t.reset();
    await request(bank.base).post('/sandbox/admin/reset').set(asAdmin);
  });

  const deposit = (reference: string, amountMinor: number) => request(bank.base).post('/sandbox/payer/transfer-in').set(asAdmin).send({ reference, amount_minor: amountMinor });
  const reconcile = () => t.app.get(StatementsService).reconcile('bank_transfer', { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });

  it('el pagador deposita con la referencia de las instrucciones y el IMPORTE exacto: el banco no avisa, y al conciliar el extracto el cobro queda cobrado', async () => {
    const created = await charge(t, { method: 'bank_transfer', amount_minor: 20000 });
    expect(created.body.status).toBe('requires_action');
    const reference = created.body.next_action.reference as string;
    expect(reference).toMatch(/^TR[A-Z0-9]{10}$/);
    expect((await reconcile()).captured).toBe(0); // todavía no depositó
    expect((await deposit(reference, 20000)).status).toBe(201);
    expect(await statusOf(t, created.body.id)).toBe('requires_action'); // el banco no notifica
    expect(await reconcile()).toMatchObject({ lines: 1, matched: 1, captured: 1, exceptions: 0 });
    expect(await statusOf(t, created.body.id)).toBe('succeeded');
    expect(await reconcile()).toMatchObject({ captured: 0 }); // idempotente
    const evs = (await events(t)).filter((e) => (e.envelope.data as { charge_id?: string }).charge_id === created.body.id);
    expect(evs).toHaveLength(1);
    const statement = await get(t.app, `/statements?connector=bank_transfer&from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`, asSettlement);
    expect(statement.body.data).toEqual([expect.objectContaining({ our_reference: reference, charge_id: created.body.id, amount_minor: 20000, payment_intent_id: expect.stringMatching(/^pi_/) })]);
  });

  it('límite/inválido: referencia correcta con OTRO importe (Bs 190,00) NO captura (amount_mismatch); un depósito sin referencia o con una ajena queda como excepción', async () => {
    const created = await charge(t, { method: 'bank_transfer', amount_minor: 20000 });
    const reference = created.body.next_action.reference as string;
    await deposit(reference, 19000);
    await deposit('TRZZZZZZZZZZ', 20000);
    const summary = await reconcile();
    expect(summary).toMatchObject({ lines: 2, captured: 0, exceptions: 2 });
    expect((await t.db.pool.query('SELECT kind FROM statement_exceptions ORDER BY kind')).rows.map((r) => r.kind)).toEqual(['amount_mismatch', 'unmatched']);
    expect(await statusOf(t, created.body.id)).toBe('requires_action');
    // Un cobro por QR NO ensucia el extracto de transferencias (cuentas separadas).
    await charge(t, { amount_minor: 10000 });
    expect(await reconcile()).toMatchObject({ lines: 2 });
  });
});
