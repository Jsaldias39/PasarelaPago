import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jsQR from 'jsqr';
import pngjs from 'pngjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createIsolatedDatabase, loadContract, TEST_DATABASE_URL, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database.module';
import { parseMpmPayload } from '../src/emv';
import { QrController } from '../src/qr/qr.controller';
import { routesOf } from './support/routes';

const REPO = join(process.cwd(), '../..');
const SQL = [join(process.cwd(), 'sql/001_qr_codes.sql'), join(REPO, 'contracts/packages/idempotency/sql/001_idempotency_keys.sql')];
// Contrato OFICIAL en contracts/ (la propuesta de la ola 1 ya se integró).
const SPEC = join(REPO, 'contracts/openapi/internal-qr-v1.yaml');

let db: IsolatedDatabase;
let appPool: Pool;
let app: INestApplication;
let contract: ContractValidator;
/** Todas las llamadas llevan el modo de la CLAVE (`test`, D-28) salvo que la prueba lo quite a propósito. */
const as = (service = 'pay-connectors', mode: string | undefined = 'test') => ({ 'x-service-id': service, ...(mode !== undefined && { 'x-pay-mode': mode }) });
let seq = 0;
const uniqueKey = () => `key-${process.pid}-${(seq += 1)}-padding`;
const intentId = () => `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

const dynamic = (over: Record<string, unknown> = {}) => ({
  kind: 'dynamic',
  merchant_id: 'mc_clinicasantacruz1',
  merchant_name: 'Clínica Santa María',
  merchant_city: 'Santa Cruz',
  currency: 'BOB',
  amount_minor: 10000,
  payment_intent_id: intentId(),
  expires_at: inAnHour(),
  ...over,
});

async function post(path: string, body: unknown, headers: Record<string, string> = as(), key: string | null = uniqueKey()) {
  const req = request(app.getHttpServer()).post(path).set(headers);
  if (key) req.set('idempotency-key', key);
  return req.send(body as object);
}

beforeAll(async () => {
  db = await createIsolatedDatabase(SQL);
  contract = await loadContract(SPEC);
  // La app tiene su propio pool (sobre el mismo esquema) porque DatabaseModule lo cierra al apagarse.
  appPool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 20 });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PG_POOL).useValue(appPool).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0); // un solo servidor escuchando: supertest no abre uno por pedido
});
afterAll(async () => {
  await app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('TRUNCATE qr_codes, idempotency_keys');
});

describe('POST /qr', () => {
  it('emite un QR dinámico: respuesta del contrato, payload EMVCo válido con el monto, la referencia y el CRC', async () => {
    const response = await post('/qr', dynamic());
    expect(response.status).toBe(201);
    contract.assertResponse({ method: 'POST', path: '/qr', status: 201, body: response.body });
    const parsed = parseMpmPayload(response.body.payload);
    expect(parsed).toMatchObject({ crcValid: true, pointOfInitiation: 'dynamic', amount: '100.00', currencyNumeric: '068', country: 'BO', referenceLabel: response.body.reference });
    expect(response.body).toMatchObject({ kind: 'dynamic', status: 'active', amount_minor: 10000, currency: 'BOB' });
    expect(response.body.reference).toMatch(/^PQ[A-Z2-7]{14}$/);
  });

  it('REQ: sin Idempotency-Key ⇒ 400 idempotency_key_required', async () => {
    const response = await post('/qr', dynamic(), as(), null);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('idempotency_key_required');
    contract.assertResponse({ method: 'POST', path: '/qr', status: 400, body: response.body });
  });

  it('idempotencia: 20 pedidos simultáneos con la misma clave y cuerpo crean UN solo QR', async () => {
    const key = uniqueKey();
    const body = dynamic();
    const responses = await Promise.all(Array.from({ length: 20 }, () => post('/qr', body, as(), key)));
    // los que llegan mientras el primero sigue en curso reciben 409 (comportamiento de @pay/idempotency); los demás, el mismo QR
    const ok = responses.filter((r) => r.status === 201 || r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    for (const r of responses.filter((x) => x.status === 409)) expect(r.body.code).toBe('idempotency_request_in_progress');
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM qr_codes');
    expect(rows.rows[0].n).toBe(1);
    const again = await post('/qr', body, as(), key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
  });

  it('la misma clave con OTRO cuerpo ⇒ 422 idempotency_key_reused y no crea nada nuevo', async () => {
    const key = uniqueKey();
    await post('/qr', dynamic(), as(), key);
    const other = await post('/qr', dynamic({ amount_minor: 20000 }), as(), key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('idempotency_key_reused');
    contract.assertResponse({ method: 'POST', path: '/qr', status: 422, body: other.body });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM qr_codes')).rows[0].n).toBe(1);
  });

  it('estático: sin monto, `***` de referencia, y un solo vigente por comercio (el segundo pedido devuelve el mismo con 200)', async () => {
    const body = { kind: 'static', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB' };
    const first = await post('/qr', body);
    const second = await post('/qr', body);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
    contract.assertResponse({ method: 'POST', path: '/qr', status: 200, body: second.body });
    expect(parseMpmPayload(first.body.payload)).toMatchObject({ crcValid: true, pointOfInitiation: 'static', amount: null, referenceLabel: '***' });
  });

  it('un segundo QR dinámico para el mismo intento ⇒ 409 hasta que se anule el anterior', async () => {
    const pi = intentId();
    const first = await post('/qr', dynamic({ payment_intent_id: pi }));
    const blocked = await post('/qr', dynamic({ payment_intent_id: pi }));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('invalid_state_transition');
    await request(app.getHttpServer()).post(`/qr/${first.body.id}/cancel`).set(as()).expect(200);
    expect((await post('/qr', dynamic({ payment_intent_id: pi }))).status).toBe(201);
  });

  it('validación: acumula los errores por campo y rechaza campos no declarados', async () => {
    const response = await post('/qr', { kind: 'dynamic', merchant_id: 'x', merchant_name: '', merchant_city: 5, currency: 'USD', amount_minor: 0, hack: true });
    expect(response.status).toBe(422);
    const fields = response.body.errors.map((e: { field: string }) => e.field).sort();
    expect(fields).toEqual(expect.arrayContaining(['merchant_id', 'merchant_name', 'merchant_city', 'currency', 'amount_minor', 'hack', 'payment_intent_id', 'expires_at']));
    contract.assertResponse({ method: 'POST', path: '/qr', status: 422, body: response.body });
    expect((await post('/qr', { kind: 'static', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'X', merchant_city: 'Y', currency: 'BOB', amount_minor: 5 })).status).toBe(422);
    expect((await post('/qr', dynamic({ expires_at: '2020-01-01T00:00:00Z' }))).status).toBe(422);
    expect((await post('/qr', dynamic({ merchant_name: 'N'.repeat(40) }))).body.errors[0]).toMatchObject({ field: 'qr', code: 'too_long' });
    expect((await post('/qr', 'no soy un objeto')).status).toBe(422);
  });

  it('los pedidos solo se validan contra el contrato: el cuerpo válido pasa validateRequest y el inválido no', () => {
    expect(contract.validateRequest({ method: 'POST', path: '/qr', body: dynamic() })).toEqual([]);
    expect(contract.validateRequest({ method: 'POST', path: '/qr', body: { kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1' } }).length).toBeGreaterThan(0);
  });
});

describe('consulta, referencia, vencimiento y anulación', () => {
  it('GET /qr/:id y /qr-references/:reference devuelven el QR; ids mal formados o ajenos son 404 sin distinguirse', async () => {
    const created = (await post('/qr', dynamic())).body;
    const byId = await request(app.getHttpServer()).get(`/qr/${created.id}`).set(as());
    contract.assertResponse({ method: 'GET', path: `/qr/${created.id}`, status: 200, body: byId.body });
    const byRef = await request(app.getHttpServer()).get(`/qr-references/${created.reference}`).set(as());
    expect(byRef.body.id).toBe(created.id);
    for (const path of ['/qr/qr_nonexistent1234', '/qr/basura', '/qr-references/NOEXISTE', "/qr-references/a'b"]) {
      const r = await request(app.getHttpServer()).get(path).set(as());
      expect(r.status).toBe(404);
      contract.assertResponse({ method: 'GET', path: '/qr/qr_x', status: 404, body: r.body });
    }
  });

  it('un QR dinámico vencido pasa a `expired` al leerlo, y aun así se puede anular', async () => {
    const created = (await post('/qr', dynamic())).body;
    await db.pool.query("UPDATE qr_codes SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
    expect((await request(app.getHttpServer()).get(`/qr/${created.id}`).set(as())).body.status).toBe('expired');
    expect((await request(app.getHttpServer()).get(`/qr-references/${created.reference}`).set(as())).body.status).toBe('expired');
    const canceled = await request(app.getHttpServer()).post(`/qr/${created.id}/cancel`).set(as());
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
  });

  it('anular es idempotente: la segunda vez devuelve el mismo QR anulado sin cambiar la fecha', async () => {
    const created = (await post('/qr', dynamic())).body;
    await request(app.getHttpServer()).post(`/qr/${created.id}/cancel`).set(as()).expect(200);
    const first = (await db.pool.query('SELECT canceled_at FROM qr_codes WHERE id = $1', [created.id])).rows[0].canceled_at;
    const second = await request(app.getHttpServer()).post(`/qr/${created.id}/cancel`).set(as()).expect(200);
    expect(second.body.status).toBe('canceled');
    expect((await db.pool.query('SELECT canceled_at FROM qr_codes WHERE id = $1', [created.id])).rows[0].canceled_at).toEqual(first);
    expect((await request(app.getHttpServer()).post('/qr/qr_inexistente123/cancel').set(as())).status).toBe(404);
  });
});

describe('imagen y lectura', () => {
  it('PNG: un lector independiente (jsQR) lee exactamente el payload; SVG: es un SVG sin el texto del payload', async () => {
    const created = (await post('/qr', dynamic())).body;
    const png = await request(app.getHttpServer()).get(`/qr/${created.id}/image?format=png`).set(as()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect(png.headers['cache-control']).toBe('no-store');
    const decoded = pngjs.PNG.sync.read(png.body as Buffer);
    const read = jsQR(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
    expect(read?.data).toBe(created.payload);
    if (process.env.P4_EVIDENCE_DIR) {
      // Artefacto de evidencia (P4.H3.M4): la imagen emitida y lo que leyó el decodificador independiente.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(process.env.P4_EVIDENCE_DIR, 'P4.H3.M4-qr.png'), png.body as Buffer);
      writeFileSync(join(process.env.P4_EVIDENCE_DIR, 'P4.H3.M4-qr-decodificado.txt'), `${read?.data}\n`);
    }

    const svg = await request(app.getHttpServer()).get(`/qr/${created.id}/image`).set(as());
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    const svgText = Buffer.from(svg.body as Buffer).toString('utf8');
    expect(svgText.startsWith('<?xml') || svgText.startsWith('<svg')).toBe(true);
    expect(svgText).not.toContain(created.reference);
    expect((await request(app.getHttpServer()).get(`/qr/${created.id}/image?format=gif`).set(as())).status).toBe(422);
  });

  it('POST /qr/decode lee un payload, avisa si el CRC no coincide y rechaza la basura', async () => {
    const created = (await post('/qr', dynamic())).body;
    const ok = await post('/qr/decode', { payload: created.payload }, as(), null);
    expect(ok.body).toMatchObject({ crc_valid: true, amount: '100.00', point_of_initiation: 'dynamic' });
    contract.assertResponse({ method: 'POST', path: '/qr/decode', status: 200, body: ok.body });
    const tampered = created.payload.slice(0, 40) + (created.payload[40] === '0' ? '1' : '0') + created.payload.slice(41);
    expect((await post('/qr/decode', { payload: tampered }, as(), null)).body.crc_valid).toBe(false);
    expect((await post('/qr/decode', { payload: 'basura' }, as(), null)).status).toBe(422);
    expect((await post('/qr/decode', { payload: 5 }, as(), null)).status).toBe(422);
  });
});

describe('identidad entre servicios (matriz negativa por ruta)', () => {
  const calls: Array<[string, string, unknown]> = [
    ['post', '/qr', dynamic()],
    ['post', '/qr/decode', { payload: 'x' }],
    ['get', '/qr/qr_abcdefghij12', undefined],
    ['get', '/qr/qr_abcdefghij12/image', undefined],
    ['post', '/qr/qr_abcdefghij12/cancel', {}],
    ['get', '/qr-references/ABC123', undefined],
  ];
  it.each(calls)('%s %s: sin X-Service-Id, o de un servicio no permitido ⇒ 403', async (method, path, body) => {
    for (const headers of [{}, as('pay-edge'), as('pay-ledger'), as('PAY-CONNECTORS')]) {
      const req = (request(app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>)[method](path).set(headers).set('idempotency-key', uniqueKey());
      const response = await (body === undefined ? req : req.send(body as object));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('forbidden');
    }
  });

  it('`pay-mockbank` (el pagador simulado de la capa sandbox) puede LEER un QR con /qr/decode y NADA más', async () => {
    const created = (await post('/qr', dynamic(), as(), uniqueKey())).body;
    const decode = await post('/qr/decode', { payload: created.payload }, as('pay-mockbank'), null);
    expect(decode.status).toBe(200);
    expect(decode.body.crc_valid).toBe(true);
    expect((await post('/qr/decode', { payload: created.payload }, { 'x-pay-mode': 'test' }, null)).status).toBe(403); // sin identidad sigue negado
    expect((await post('/qr', dynamic(), as('pay-mockbank'), uniqueKey())).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`/qr/${created.id}`).set(as('pay-mockbank'))).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`/qr/${created.id}/cancel`).set(as('pay-mockbank')).set('idempotency-key', uniqueKey()).send({})).status).toBe(403);
  });

  it('la salud es pública (sin identidad)', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});

describe('contrato', () => {
  it('toda operación del contrato tiene su ruta implementada, y ninguna ruta sobra', () => {
    expect(routesOf(QrController)).toEqual(contract.operations().sort());
  });
});
