import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { captureOutput } from './helpers/capture';
import { asMerchant, httpApp } from './helpers/http';
import { eventsOf, key, MC, QR_FEES, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * Gate «Datos sensibles» (PLAN-MAESTRO §7) de pay-payments, tanda 3c: ni el NOMBRE DEL PAGADOR (`payer_name`) ni la RAZÓN SOCIAL del comercio
 * (`legal_name`) ni un PAN salen en logs, respuestas (también las de error), eventos del outbox, llamadas a los conectores y al ledger, ni filas de la base
 * salvo los dos lugares DECLARADOS (la columna `payment_intents.payer_name` mientras el intento no es terminal y `merchant_replica.legal_name`).
 * A priesgo se le manda el nombre A PROPÓSITO (D-29): ese es el único tercero que lo recibe, y se comprueba que lo recibe (control positivo).
 * Los valores son CANARIOS sintéticos; 4111…1111 es el PAN de prueba público. Trazas: `test/path-sensitive.spec.ts` (bytes OTLP reales).
 */
const PAYER = 'CANARIO PAGADOR UNICO ZETA';
const LEGAL = 'CANARIO RAZON SOCIAL UNICA SRL';
const PAN = '4111111111111111';
const CANARIES = [PAYER, LEGAL, 'CANARIO PAGADOR', 'CANARIO RAZON'];
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };

let stack: Stack;
let app: INestApplication;
beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  await seedMerchant(stack, MC, 'active', QR_FEES, LEGAL);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.risk.mode = 'allow';
});

const leaks = (text: string): string[] => [...CANARIES.filter((c) => text.includes(c)), ...(text.includes(PAN) ? [PAN] : [])];

describe('el detector (control positivo): grita sobre el material con un canario', () => {
  it.each([PAYER, `x ${LEGAL} y`, `{"payer_name":"${PAYER}"}`, `tarjeta ${PAN}`])('detecta %j', (text) => expect(leaks(text).length).toBeGreaterThan(0));
  it('no grita sobre texto limpio', () => expect(leaks('{"object":"payment_intent","status":"succeeded"}')).toEqual([]));
});

describe('payer_name y legal_name no salen de pay-payments (salvo a pay-risk, a propósito)', () => {
  it('cobro exitoso, cobro denegado por riesgo, riesgo caído y entradas inválidas: 0 apariciones en logs, respuestas, eventos, llamadas a conectores/ledger y filas', async () => {
    const responses: string[] = [];
    const send = async (body: object, idem = key()): Promise<request.Response> => {
      const response = await request(app.getHttpServer()).post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', idem).send(body);
      responses.push(JSON.stringify(response.body), JSON.stringify(response.headers));
      return response;
    };
    const ids: string[] = [];
    const { output } = await captureOutput(async () => {
      // 1) exitoso: con nombre de pagador, hasta succeeded
      const ok = await send({ ...QR, payer_name: PAYER });
      expect(ok.status).toBe(201);
      ids.push(ok.body.id);
      responses.push(JSON.stringify((await request(app.getHttpServer()).get(`/payment_intents/${ok.body.id}`).set(asMerchant(MC))).body));
      stack.connectors.setChargeStatus(stack.connectors.chargeFor(ok.body.id)!.id, 'succeeded');
      await stack.orchestrator.signalCharge(ok.body.id, { status: 'captured' });
      await waitFor(async () => ((await statusOf(stack, ok.body.id)) === 'succeeded' ? true : undefined), 30_000, 'succeeded');
      // 2) denegado por riesgo
      stack.risk.mode = 'deny';
      const denied = await send({ ...QR, payer_name: PAYER });
      ids.push(denied.body.id);
      await waitFor(async () => ((await statusOf(stack, denied.body.id)) === 'failed' ? true : undefined), 30_000, 'risk_denied');
      // 3) riesgo caído (fail-closed)
      stack.risk.mode = 'down';
      const down = await send({ ...QR, payer_name: PAYER });
      ids.push(down.body.id);
      await waitFor(async () => ((await statusOf(stack, down.body.id)) === 'failed' ? true : undefined), 30_000, 'risk_unavailable');
      stack.risk.mode = 'allow';
      // 4) entradas inválidas: la validación no repite el valor
      for (const bad of ['C'.repeat(190) + PAYER, `${PAYER} ${PAN}`, '   ', 12345]) {
        const r = await send({ ...QR, payer_name: bad });
        expect(r.status).toBe(422);
      }
      // 5) cuerpo con un campo que el contrato no tiene y el canario adentro
      expect((await send({ ...QR, payer: { name: PAYER }, legal_name: LEGAL })).status).toBe(422);
      expect((await send({ ...QR, description: `a nombre de ${PAYER}` })).status).toBe(201); // el texto libre del COMERCIO es suyo: se guarda en SU intento; ver abajo
    });

    // La `description` es dato del comercio y SE DEVUELVE a él: la prueba 5 la deja fuera del escaneo de filas/respuestas con esta única excepción explícita.
    const scrubbed = (text: string) => text.split(`a nombre de ${PAYER}`).join('<descripcion-del-comercio>');
    const events = JSON.stringify((await stack.db.pool.query('SELECT type, envelope FROM outbox_events ORDER BY seq')).rows);
    const tables = (await stack.db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).rows as { table_name: string }[];
    const rowsByTable = new Map<string, string>();
    for (const { table_name } of tables) rowsByTable.set(table_name, JSON.stringify((await stack.db.pool.query(`SELECT row_to_json(t) FROM "${table_name}" t`)).rows));
    const outbound = JSON.stringify([...stack.connectors.server.calls, ...stack.ledger.server.calls].map((c) => ({ method: c.method, path: c.path, body: c.body })));

    expect({ donde: 'logs', hits: leaks(scrubbed(output)) }).toEqual({ donde: 'logs', hits: [] });
    expect({ donde: 'respuestas', hits: leaks(scrubbed(responses.join('\n'))) }).toEqual({ donde: 'respuestas', hits: [] });
    expect({ donde: 'eventos', hits: leaks(scrubbed(events)) }).toEqual({ donde: 'eventos', hits: [] });
    expect({ donde: 'conectores y ledger', hits: leaks(scrubbed(outbound)) }).toEqual({ donde: 'conectores y ledger', hits: [] });
    const holders = [...rowsByTable].filter(([, dump]) => leaks(scrubbed(dump)).length > 0).map(([t]) => t);
    expect(holders).toEqual(['merchant_replica']); // la razón social vive SOLO en la réplica del comercio
    expect(Number((await stack.db.pool.query("SELECT count(*) AS n FROM payment_intents WHERE payer_name IS NOT NULL AND status IN ('succeeded', 'failed', 'canceled', 'expired')")).rows[0].n)).toBe(0);

    // Controles positivos: el escaneo no está ciego.
    expect(events.length).toBeGreaterThan(500);
    expect((await eventsOf(stack, ids[0]!)).length).toBeGreaterThan(0);
    expect(responses.join('\n')).toContain('requires_action');
    expect(JSON.stringify(stack.risk.server.calls.map((c) => c.body))).toContain(PAYER); // riesgo SÍ recibe el nombre (D-29, a propósito)
    expect(JSON.stringify(stack.risk.server.calls.map((c) => c.body))).toContain(LEGAL);
    expect(rowsByTable.get('merchant_replica')).toContain(LEGAL);
    expect(stack.connectors.server.calls.length).toBeGreaterThan(0);
  });
});
