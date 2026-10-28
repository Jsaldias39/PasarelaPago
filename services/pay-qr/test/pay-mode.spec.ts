import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, SERVICE_CONFIG } from '../src/config';
import { PG_POOL } from '../src/database.module';
import { parsePayMode } from '../src/qr/pay-mode';

// D-28 (X-Pay-Mode) en pay-qr: se exige en toda ruta interna, tiene que coincidir con el despliegue, se guarda y filtra la lectura por (id, modo).
const SQL = [join(process.cwd(), 'sql/ddl.sql')];

let db: IsolatedDatabase;
let sandbox: INestApplication; // despliegue sandbox: atiende claves `test`
let live: INestApplication; // despliegue live: atiende claves `live` (misma base: lo que dejarían dos despliegues sobre una base)
const pools: Pool[] = [];
let seq = 0;
const uniqueKey = () => `key-${process.pid}-${(seq += 1)}-padding`;
const intentId = () => `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
const as = (mode?: string, service = 'pay-connectors') => ({ 'x-service-id': service, ...(mode !== undefined && { 'x-pay-mode': mode }) });
const dynamic = (over: Record<string, unknown> = {}) => ({ kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: 10000, payment_intent_id: intentId(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...over });
const staticQr = () => ({ kind: 'static', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB' });

async function build(mode: 'sandbox' | 'live'): Promise<INestApplication> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 5 });
  pools.push(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(SERVICE_CONFIG)
    .useValue({ ...loadConfig(), mode })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return app;
}

beforeAll(async () => {
  db = await createIsolatedDatabase(SQL);
  sandbox = await build('sandbox');
  live = await build('live');
});
afterAll(async () => {
  await sandbox.close();
  await live.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('TRUNCATE qr_codes, idempotency_keys');
});

const count = async (table: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const create = (app: INestApplication, mode: string | undefined, body: unknown = dynamic(), key: string | null = uniqueKey()) => {
  const req = request(app.getHttpServer()).post('/qr').set(as(mode));
  if (key) req.set('idempotency-key', key);
  return req.send(body as object);
};

describe('parsePayMode (correcto, límite, inválido)', () => {
  it('acepta solo test y live', () => {
    expect(parsePayMode('test')).toBe('test');
    expect(parsePayMode('live')).toBe('live');
    for (const bad of [undefined, '', 'TEST', 'Live', ' test', 'test,live', 'sandbox', 'prod', ['test'], ['test', 'live']] as Array<string | string[] | undefined>) {
      expect(() => parsePayMode(bad)).toThrow(expect.objectContaining({ code: 'forbidden', status: 403 }));
    }
  });
});

describe('toda ruta interna exige X-Pay-Mode ∈ {test, live} y que coincida con el despliegue', () => {
  const ROUTES: Array<[string, (app: INestApplication, mode?: string) => request.Test]> = [
    ['POST /qr', (app, mode) => request(app.getHttpServer()).post('/qr').set(as(mode)).set('idempotency-key', uniqueKey()).send(dynamic())],
    ['POST /qr/decode', (app, mode) => request(app.getHttpServer()).post('/qr/decode').set(as(mode)).send({ payload: 'x' })],
    ['GET /qr/{id}', (app, mode) => request(app.getHttpServer()).get('/qr/qr_abcdefghij12').set(as(mode))],
    ['GET /qr/{id}/image', (app, mode) => request(app.getHttpServer()).get('/qr/qr_abcdefghij12/image').set(as(mode))],
    ['POST /qr/{id}/cancel', (app, mode) => request(app.getHttpServer()).post('/qr/qr_abcdefghij12/cancel').set(as(mode))],
    ['GET /qr-references/{reference}', (app, mode) => request(app.getHttpServer()).get('/qr-references/ABC123').set(as(mode))],
  ];

  for (const [name, send] of ROUTES) {
    describe(name, () => {
      it.each([['ausente', undefined], ['vacío', ''], ['en mayúsculas', 'TEST'], ['con otro valor', 'prod'], ['el del despliegue (sandbox)', 'sandbox'], ['dos valores', 'test,live']])(
        '%s ⇒ 403 forbidden y SIN efecto',
        async (_n, value) => {
          const response = await send(sandbox, value);
          expect(response.status).toBe(403);
          expect(response.body.code).toBe('forbidden');
          expect(await count('qr_codes')).toBe(0);
          expect(await count('idempotency_keys')).toBe(0);
        },
      );

      it('`live` contra un despliegue sandbox ⇒ 403 y SIN efecto; `test` contra uno live ⇒ 403; cada uno pasa en SU despliegue', async () => {
        for (const [app, wrong] of [[sandbox, 'live'], [live, 'test']] as const) {
          const response = await send(app, wrong);
          expect(response.status).toBe(403);
          expect(response.body.code).toBe('forbidden');
        }
        expect(await count('qr_codes')).toBe(0);
        expect(await count('idempotency_keys')).toBe(0);
        expect((await send(sandbox, 'test')).status).not.toBe(403);
        expect((await send(live, 'live')).status).not.toBe(403);
      });
    });
  }

  it('el modo no se toma del cuerpo ni de la consulta', async () => {
    const response = await request(sandbox.getHttpServer()).post('/qr?mode=test').set(as()).set('idempotency-key', uniqueKey()).send({ ...dynamic(), mode: 'test' });
    expect(response.status).toBe(403);
    expect(await count('qr_codes')).toBe(0);
  });
});

describe('el modo se guarda y toda lectura filtra por (id, modo)', () => {
  it('cada QR guarda el modo de SU pedido', async () => {
    const a = await create(sandbox, 'test');
    const b = await create(live, 'live');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await db.pool.query('SELECT pay_mode FROM qr_codes WHERE id = $1', [a.body.id])).rows[0].pay_mode).toBe('test');
    expect((await db.pool.query('SELECT pay_mode FROM qr_codes WHERE id = $1', [b.body.id])).rows[0].pay_mode).toBe('live');
  });

  it('un QR del OTRO modo da 404 en las 5 lecturas/escrituras por id o referencia, y no cambia', async () => {
    const mine = await create(sandbox, 'test');
    const other = await create(live, 'live');
    expect((await request(sandbox.getHttpServer()).get(`/qr/${mine.body.id}`).set(as('test'))).status).toBe(200); // control
    const forTest = [
      request(sandbox.getHttpServer()).get(`/qr/${other.body.id}`).set(as('test')),
      request(sandbox.getHttpServer()).get(`/qr/${other.body.id}/image`).set(as('test')),
      request(sandbox.getHttpServer()).post(`/qr/${other.body.id}/cancel`).set(as('test')),
      request(sandbox.getHttpServer()).get(`/qr-references/${other.body.reference}`).set(as('test')),
    ];
    for (const req of forTest) {
      const response = await req;
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('resource_not_found');
    }
    const forLive = [
      request(live.getHttpServer()).get(`/qr/${mine.body.id}`).set(as('live')),
      request(live.getHttpServer()).post(`/qr/${mine.body.id}/cancel`).set(as('live')),
      request(live.getHttpServer()).get(`/qr-references/${mine.body.reference}`).set(as('live')),
    ];
    for (const req of forLive) expect((await req).status).toBe(404);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM qr_codes WHERE canceled_at IS NOT NULL')).rows[0].n).toBe(0);
    expect((await request(live.getHttpServer()).get(`/qr/${other.body.id}`).set(as('live'))).status).toBe(200); // cada uno ve el suyo
  });
});

describe('la misma Idempotency-Key, el mismo intento y el mismo comercio en test y en live son operaciones distintas', () => {
  it('misma clave y mismo cuerpo en los dos modos ⇒ dos QR distintos, sin repetir la respuesta del otro modo ni chocar', async () => {
    const key = uniqueKey();
    const body = dynamic();
    const a = await create(sandbox, 'test', body, key);
    const b = await create(live, 'live', body, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).not.toBe(b.body.id);
    expect(b.headers['idempotency-replayed']).toBeUndefined();
    expect((await db.pool.query('SELECT scope FROM idempotency_keys WHERE key = $1 ORDER BY scope', [key])).rows).toEqual([{ scope: 'pay-connectors|live' }, { scope: 'pay-connectors|test' }]);
    // Dentro de un modo, la repetición sí devuelve el original.
    const again = await create(sandbox, 'test', body, key);
    expect(again.body.id).toBe(a.body.id);
    expect(again.headers['idempotency-replayed']).toBe('true');
  });

  it('el mismo intento admite un QR vigente por modo, y un solo QR estático vigente por comercio y modo', async () => {
    const intent = intentId();
    expect((await create(sandbox, 'test', dynamic({ payment_intent_id: intent }))).status).toBe(201);
    expect((await create(live, 'live', dynamic({ payment_intent_id: intent }))).status).toBe(201);
    expect((await create(sandbox, 'test', dynamic({ payment_intent_id: intent }))).status).toBe(409); // dentro del modo sigue el límite
    const s1 = await create(sandbox, 'test', staticQr());
    const s2 = await create(live, 'live', staticQr());
    const s3 = await create(live, 'live', staticQr());
    expect([s1.status, s2.status, s3.status]).toEqual([201, 201, 200]);
    expect(s1.body.id).not.toBe(s2.body.id);
    expect(s3.body.id).toBe(s2.body.id);
  });
});
