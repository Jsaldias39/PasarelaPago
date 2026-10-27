import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { createIsolatedDatabase, loadContract, TEST_DATABASE_URL, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../../src/app.module';
import { CLOCK, type Clock } from '../../src/clock';
import { loadConfig, SERVICE_CONFIG, type ServiceConfig } from '../../src/config';
import { PG_POOL } from '../../src/database.module';

export const REPO = join(process.cwd(), '../..');
export const SQL = [join(process.cwd(), 'sql/001_mockbank.sql')];
export const SPEC = join(process.cwd(), 'openapi/mockbank-v1.proposal.yaml');

/** Reloj de pruebas: avanza solo cuando se le ordena. */
export class TestClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
}

/** [DOBLE] Receptor de callbacks: hace de `POST /callbacks/mock` de pay-connectors. Responde con lo que diga `respond`. */
export class CallbackReceiver {
  readonly received: Received[] = [];
  respond: () => number = () => 200;
  private server: Server | undefined;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.received.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = this.respond();
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as { port: number }).port}/callbacks/mock`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  bodies(): Array<Record<string, unknown>> {
    return this.received.map((r) => JSON.parse(r.rawBody) as Record<string, unknown>);
  }
}

export interface TestApp {
  readonly app: INestApplication;
  readonly db: IsolatedDatabase;
  readonly clock: TestClock;
  readonly contract: ContractValidator;
  readonly receiver: CallbackReceiver;
  readonly config: ServiceConfig;
  close(): Promise<void>;
  reset(): Promise<void>;
}

/** Levanta la app real sobre un esquema aislado de Postgres real, con reloj de pruebas y un receptor de callbacks. */
export async function createTestApp(options: { config?: Partial<ServiceConfig> } = {}): Promise<TestApp> {
  const db = await createIsolatedDatabase(SQL);
  const contract = await loadContract(SPEC);
  const receiver = new CallbackReceiver();
  await receiver.start();
  const appPool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 10 });
  const clock = new TestClock();
  const config: ServiceConfig = { ...loadConfig(), callbackUrl: receiver.url, delayMs: 5000, hangMs: 300, ...options.config };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(appPool)
    .overrideProvider(SERVICE_CONFIG)
    .useValue(config)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return {
    app,
    db,
    clock,
    contract,
    receiver,
    config,
    async close() {
      await app.close();
      await receiver.stop();
      await db.drop();
    },
    async reset() {
      await request(app.getHttpServer()).post('/sandbox/admin/reset').set(asAdmin);
      receiver.received.length = 0;
      receiver.respond = () => 200;
    },
  };
}

/** Todas las llamadas del conector llevan el modo de la CLAVE (`test`, D-28). */
export const asConnectors = { 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test' };
export const asAdmin = { 'x-service-id': 'pay-mockbank' };

let seq = 0;
export const chargeRef = (): string => `ch_t${process.pid}${String((seq += 1)).padStart(8, '0')}`.slice(0, 30);
export const refundRef = (): string => `cr_t${process.pid}${String((seq += 1)).padStart(8, '0')}`.slice(0, 30);

export function chargeBody(over: Record<string, unknown> = {}, clock?: TestClock): Record<string, unknown> {
  const base = clock ? clock.now().getTime() : Date.now();
  return { reference: chargeRef(), amount_minor: 10000, currency: 'BOB', method: 'qr', expires_at: new Date(base + 3_600_000).toISOString(), ...over };
}

export const post = (t: TestApp, path: string, body: unknown, headers: Record<string, string> = asConnectors) => request(t.app.getHttpServer()).post(path).set(headers).send(body as object);
export const get = (t: TestApp, path: string, headers: Record<string, string> = asConnectors) => request(t.app.getHttpServer()).get(path).set(headers);
export const deliver = async (t: TestApp): Promise<{ delivered: number; failed: number }> => (await request(t.app.getHttpServer()).post('/sandbox/admin/deliver').set(asAdmin)).body;
