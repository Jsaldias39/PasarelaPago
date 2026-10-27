import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { captureOutput } from './helpers/capture';
import { asMerchant, httpApp } from './helpers/http';
import { key, MC, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

let stack: Stack;
let app: INestApplication;
const PANS = ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '5555555555554444', '378282246310005'];
const TOKEN = 'tok_abcdefghij12';

beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});

async function dumpDatabase(): Promise<string> {
  const tables = await stack.db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
  const parts: string[] = [];
  for (const { table_name } of tables.rows) parts.push(JSON.stringify((await stack.db.pool.query(`SELECT row_to_json(t) FROM "${table_name}" t`)).rows));
  return parts.join('\n');
}
const found = (haystack: string) => PANS.filter((pan) => haystack.includes(pan));

describe('P3.H3.M3 · medio tarjeta: el PAN no existe fuera de la bóveda (grep → 0 en logs, eventos y bases)', () => {
  it('con un PAN metido en CADA campo posible y un cobro con token completo, no queda rastro en tablas, outbox, idempotencia, logs, respuestas ni llamadas a los conectores', async () => {
    const responses: string[] = [];
    const send = async (build: (r: request.Agent) => request.Test): Promise<request.Response> => {
      const response = await build(request(app.getHttpServer()) as unknown as request.Agent);
      responses.push(JSON.stringify(response.body), JSON.stringify(response.headers));
      return response;
    };
    const post = (body: unknown, idempotencyKey: string = key()) => send((r) => (r as unknown as { post(u: string): request.Test }).post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', idempotencyKey).send(body as object));

    const { output } = await captureOutput(async () => {
      const base = { amount_minor: 10000, currency: 'BOB' };
      // 1) el PAN en cada campo de texto libre / token → siempre 422 y nunca guardado
      for (const pan of PANS) {
        expect((await post({ ...base, payment_method: { type: 'qr' }, description: `pago ${pan}` })).status).toBe(422);
        expect((await post({ ...base, payment_method: { type: 'qr' }, metadata: { nota: pan } })).status).toBe(422);
        expect((await post({ ...base, payment_method: { type: 'card', card_token: pan } })).status).toBe(422);
        expect((await post({ ...base, payment_method: { type: 'wallet', wallet_authorization: pan } })).status).toBe(422);
        expect((await post({ ...base, payment_method: { type: 'qr' } }, `idem-${pan}`)).status).toBe(422);
        expect((await send((r) => (r as unknown as { get(u: string): request.Test }).get(`/payment_intents/${pan}`).set(asMerchant(MC)))).status).toBe(404);
      }
      // 2) un reembolso con PAN en metadata
      const first = await post({ ...base, payment_method: { type: 'qr' } });
      expect((await send((r) => (r as unknown as { post(u: string): request.Test }).post(`/payment_intents/${first.body.id}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: 100, metadata: { n: PANS[0]! } }))).status).toBe(422);
      // 3) el camino legítimo: la tarjeta viaja SOLO como token y el cobro se completa
      const card = await post({ ...base, payment_method: { type: 'card', card_token: TOKEN } });
      expect(card.status).toBe(201);
      const id = card.body.id as string;
      stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
      await stack.orchestrator.signalCharge(id, { status: 'captured' });
      await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'cobro con tarjeta');
    });

    const receivedByConnectors = JSON.stringify(stack.connectors.server.calls.map((c) => ({ body: c.body, headers: c.headers, path: c.path })));
    const receivedByLedger = JSON.stringify(stack.ledger.server.calls.map((c) => ({ body: c.body, headers: c.headers, path: c.path })));
    const receivedByRisk = JSON.stringify(stack.risk.server.calls.map((c) => ({ body: c.body, headers: c.headers, path: c.path })));
    const database = await dumpDatabase();
    for (const [donde, text] of [['tablas', database], ['logs', output], ['respuestas', responses.join('\n')], ['conectores', receivedByConnectors], ['ledger', receivedByLedger], ['riesgo', receivedByRisk]] as const) {
      expect({ donde, hits: found(text) }).toEqual({ donde, hits: [] });
    }
    // El conector recibió el token, no un número; y el grep miró datos de verdad.
    expect(receivedByConnectors).toContain(TOKEN);
    expect(database).toContain(TOKEN);
    expect(database.length).toBeGreaterThan(1000);
    expect((await stack.db.pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n).toBeGreaterThan(3);
    // Control positivo: el detector sí ve un PAN cuando lo hay.
    expect(found(`x ${PANS[1]} y`)).toEqual([PANS[1]]);
  });
});
