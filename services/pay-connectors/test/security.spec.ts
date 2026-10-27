import fs from 'node:fs';
import request from 'supertest';
import { PollerService } from '../src/core/poller.service';
import { HealthService } from '../src/core/health.service';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import { StatementsService } from '../src/core/statements.service';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';

const SECRET = process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET as string;
const SECRET_BODY = SECRET.replace(/^whsec_/, '');
const CARD_TOKEN = 'tok_sentinelcardtoken0123456789';
const PAYER = 'Juan Perez Quispe CI 7654321';
const PAN = '4111111111111111';
const FORBIDDEN = [SECRET, SECRET_BODY, CARD_TOKEN, PAYER, 'Juan Perez', PAN, '7654321'];

let t: TestApp;
const logs: string[] = [];
const originals = { writeSync: fs.writeSync, stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) };

beforeAll(async () => {
  // Captura TODO lo que el proceso escribe: pino escribe con fs.writeSync(1, …); el logger de Nest con process.stdout/stderr.
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (originals.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (originals.stdout as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (originals.stderr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  t = await createTestApp();
});
afterAll(async () => {
  (fs as { writeSync: unknown }).writeSync = originals.writeSync;
  process.stdout.write = originals.stdout as typeof process.stdout.write;
  process.stderr.write = originals.stderr as typeof process.stderr.write;
  await t.close();
});

describe('REQ-P4-6 — ni credenciales del conector ni datos del pagador en logs, eventos, errores ni base', () => {
  it('tras un recorrido completo (cobros, callbacks buenos y malos, reembolso, extracto, salud, poller) no aparece ningún dato sensible', async () => {
    await t.reset();
    const bank = t.app.get<SimulatedBank>(SIMULATED_BANK);
    const mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
    const responses: string[] = [];
    const note = (r: { text?: string; body?: unknown }) => responses.push(`${r.text ?? ''}${JSON.stringify(r.body ?? '')}`);

    // Cobros con el token y los datos del pagador en los campos libres.
    const card = await post(t.app, '/charges', chargeBody({ method: 'card', card_token: CARD_TOKEN, description: `${PAYER} ${PAN}` }, t.clock));
    const qr = await post(t.app, '/charges', chargeBody({ description: `${PAYER} ${PAN}` }, t.clock));
    const declined = await post(t.app, '/charges', chargeBody({ amount_minor: 10001, method: 'card', card_token: CARD_TOKEN, description: PAYER }, t.clock));
    for (const r of [card, qr, declined]) {
      expect(r.status).toBe(201);
      note(r);
    }
    // Rechazados por validación: el error no refleja el valor enviado.
    note(await post(t.app, '/charges', chargeBody({ amount_minor: PAN, description: PAYER }, t.clock)));
    note(await post(t.app, '/charges', chargeBody({ [PAN]: PAYER }, t.clock)));

    // Callbacks: bueno, firma alterada, firmado pero ilegible, conector desconocido.
    for (const cb of bank.dueCallbacks(t.clock.now())) {
      const signed = await mock.signCallback(cb, t.clock.now());
      note(await request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set('content-type', 'application/json').send(signed.rawBody.toString('utf8')));
      note(await request(t.app.getHttpServer()).post('/callbacks/mock').set({ ...signed.headers, 'webhook-signature': 'v1,AAAA' }).set('content-type', 'application/json').send(signed.rawBody.toString('utf8') + PAYER));
    }
    note(await request(t.app.getHttpServer()).post('/callbacks/mock').set('content-type', 'application/json').send(JSON.stringify({ payer: PAYER, pan: PAN })));
    note(await request(t.app.getHttpServer()).post(`/callbacks/${PAN}`).send(PAYER));

    // Reembolso, consulta, anulación, extracto en los tres formatos, salud, poller, proveedor caído.
    note(await post(t.app, `/charges/${qr.body.id}/refunds`, { amount_minor: 5000, reason: PAYER }));
    note(await get(t.app, `/charges/${qr.body.id}/status?refresh=true`));
    note(await post(t.app, `/charges/${card.body.id}/cancel`, undefined));
    const q = `?connector=mock&from=${new Date(t.clock.now().getTime() - 60_000).toISOString()}&to=${new Date(t.clock.now().getTime() + 60_000).toISOString()}`;
    for (const accept of ['application/json', 'application/xml', 'text/csv']) note(await get(t.app, `/statements${q}`, { ...asSettlement, accept }));
    note(await get(t.app, '/connectors/health'));
    bank.setDown(true);
    note(await post(t.app, '/charges', chargeBody({ description: PAYER }, t.clock)));
    await t.app.get(HealthService).probeAll();
    t.clock.advance(3_600_000);
    await t.app.get(PollerService).tick();
    await t.app.get(StatementsService).reconcileAll();
    bank.setDown(false);
    note(await get(t.app, `/charges/${qr.body.id}`, asPayments));
    await new Promise((resolve) => setTimeout(resolve, 100)); // deja que pino vacíe

    // Lo que hay en la base: todas las tablas, fila por fila.
    const tables = await t.db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [t.db.schema]);
    const dump: string[] = [];
    for (const { table_name: name } of tables.rows) {
      const rows = await t.db.pool.query(`SELECT row_to_json(x)::text AS j FROM "${name}" x`);
      dump.push(...rows.rows.map((r) => r.j as string));
    }
    expect(dump.length).toBeGreaterThan(20); // no es una revisión vacía

    const everything: Array<[string, string]> = [
      ['logs', logs.join('')],
      ['respuestas', responses.join('\n')],
      ['base de datos (incluye el outbox con los eventos y los intentos)', dump.join('\n')],
    ];
    // No es vacuo: los logs existen y los ids de petición sí aparecen.
    expect(logs.join('')).toContain('request completed');
    expect(dump.join('')).toContain('connector.transaction.status_changed');
    for (const [where, text] of everything) {
      for (const secret of FORBIDDEN) expect({ where, secret, found: text.includes(secret) }).toEqual({ where, secret, found: false });
      expect(text).not.toMatch(/whsec_[A-Za-z0-9+/=]{16,}/); // ningún secreto con la forma de Standard Webhooks
      expect(text).not.toMatch(/\b\d{13,19}\b.*\b(cvv|cvc)\b/i);
    }
  });

  it('el id de petición viaja en errores y respuestas para cruzarlo con el cliente, sin datos del pagador', async () => {
    const response = await post(t.app, '/charges', { payment_intent_id: 'xx' }, asPayments);
    expect(response.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).toBe(response.body.request_id);
  });
});
