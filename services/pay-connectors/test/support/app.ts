import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { createIsolatedDatabase, loadContract, TEST_DATABASE_URL, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureBodyParsers } from '../../src/app.setup';
import type { QrPort } from '../../src/connectors/mock/mock.connector';
import { PG_POOL } from '../../src/database.module';
import { loadConfig, SERVICE_CONFIG, type ServiceConfig } from '../../src/config';
import { SIMULATED_BANK } from '../../src/core/mock-pump.service';
import { TRANSFER_BANK } from '../../src/connectors.module';
import type { SimulatedBank } from '../../src/connectors/mock/simulated-bank';
import { CLOCK, QR_PORT, type Clock } from '../../src/core/tokens';

export const REPO = join(process.cwd(), '../..');
/** El esquema es el del MODELO, vendorizado (D-18): `sql/ddl.sql` ya trae las tablas técnicas (idempotencia, outbox, inbox). */
export const SQL = [join(process.cwd(), 'sql/ddl.sql')];
export const SPEC = join(REPO, 'contracts/openapi/internal-connectors-v1.yaml');

/** Reloj de pruebas: avanza solo cuando se le ordena. */
export class TestClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = date;
  }
}

/** CRC-16/CCITT-FALSE, igual que el de EMVCo; para armar payloads de QR de prueba sin importar código de pay-qr. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** [DOBLE] pay-qr: devuelve un payload con forma de EMVCo MPM y CRC válido. NO es el QR real (ese lo genera pay-qr). */
export class FakeQr implements QrPort {
  readonly issued: Array<{ chargeId: string; amountMinor: bigint; payMode: 'test' | 'live' }> = [];
  async issue(input: { chargeId: string; amountMinor: bigint; payMode: 'test' | 'live'; expiresAt: Date }): Promise<{ payload: string; expiresAt: Date }> {
    this.issued.push({ chargeId: input.chargeId, amountMinor: input.amountMinor, payMode: input.payMode });
    const body = `000201010212540${String(input.amountMinor).length}${input.amountMinor}5802BO6304`;
    return { payload: `${body}${crc16(body)}`, expiresAt: input.expiresAt };
  }
}

export interface TestApp {
  readonly app: INestApplication;
  readonly db: IsolatedDatabase;
  readonly clock: TestClock;
  readonly qr: FakeQr;
  readonly contract: ContractValidator;
  close(): Promise<void>;
  reset(): Promise<void>;
}

/** Levanta la app real sobre un esquema aislado de Postgres real (nada de ORM mockeado) con reloj y QR de prueba. */
export async function createTestApp(options: { controllers?: Array<new (...args: never[]) => unknown>; config?: Partial<ServiceConfig>; qr?: QrPort } = {}): Promise<TestApp> {
  const db = await createIsolatedDatabase(SQL);
  const contract = await loadContract(SPEC);
  const appPool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 10 });
  const clock = new TestClock();
  const qr = new FakeQr();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], ...(options.controllers && { controllers: options.controllers }) })
    .overrideProvider(PG_POOL)
    .useValue(appPool)
    .overrideProvider(SERVICE_CONFIG)
    .useValue({ ...loadConfig(), ...options.config })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(QR_PORT)
    .useValue(options.qr ?? qr)
    .compile();
  const app = moduleRef.createNestApplication(APP_OPTIONS);
  configureBodyParsers(app);
  await app.listen(0);
  return {
    app,
    db,
    clock,
    qr,
    contract,
    async close() {
      await app.close();
      await db.drop();
    },
    async reset() {
      // `DELETE` y no `TRUNCATE` en las tablas de DINERO: el modelo prohíbe TRUNCATE en connector_charges/transfers/refunds (append-only para la aplicación). Hijos primero (FK).
      for (const table of ['bank_transfer_references', 'connector_refunds', 'connector_callback_events', 'connector_api_attempts', 'connector_charges', 'connector_transfers', 'connector_health', 'connector_callback_endpoints', 'statement_exceptions']) {
        await db.pool.query(`DELETE FROM ${table}`);
      }
      // Las tablas TÉCNICAS sí con TRUNCATE (no tienen guardián ni FK): el relé del outbox corre en segundo plano y hace `UPDATE outbox_events … published_at` por fila; un
      // `DELETE FROM outbox_events` a la vez con ese UPDATE da `deadlock detected` (lo vio el log de Postgres: «DELETE FROM outbox_events» vs «UPDATE outbox_events SET published_at»),
      // mientras que TRUNCATE espera a que el relé suelte la tabla.
      await db.pool.query('TRUNCATE idempotency_keys, outbox_events, inbox_events');
      clock.set(new Date());
      qr.issued.length = 0;
      // Callbacks que el simulador dejó programados por pruebas anteriores: sus cobros ya no existen.
      for (const token of [SIMULATED_BANK, TRANSFER_BANK]) {
        const bank = app.get<SimulatedBank>(token);
        bank.reset();
      }
    },
  };
}

/** Todas las llamadas de las pruebas llevan el modo de la CLAVE (`test`, D-28) salvo que la prueba lo quite a propósito. */
const as = (service: string, mode: 'test' | 'live' = 'test') => ({ 'x-service-id': service, 'x-pay-mode': mode });
export const asPaymentsIn = (mode: 'test' | 'live') => as('pay-payments', mode);
export const asSettlementIn = (mode: 'test' | 'live') => as('pay-settlement', mode);
export const asPayments = as('pay-payments');
export const asSettlement = as('pay-settlement');

let seq = 0;
export const uniqueKey = (): string => `key-${process.pid}-${(seq += 1)}-padding`;
export const intentId = (): string => `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
export const merchantId = 'mc_clinicasantacruz1';

export function chargeBody(over: Record<string, unknown> = {}, clock?: TestClock): Record<string, unknown> {
  const base = clock ? clock.now().getTime() : Date.now();
  return {
    payment_intent_id: intentId(),
    merchant_id: merchantId,
    amount_minor: 10000,
    currency: 'BOB',
    method: 'qr',
    expires_at: new Date(base + 3_600_000).toISOString(),
    ...over,
  };
}

export function post(app: INestApplication, path: string, body: unknown, headers: Record<string, string> = asPayments, key: string | null = uniqueKey()) {
  const req = request(app.getHttpServer()).post(path).set(headers);
  if (key) req.set('idempotency-key', key);
  return req.send(body as object);
}

export const get = (app: INestApplication, path: string, headers: Record<string, string> = asPayments) => request(app.getHttpServer()).get(path).set(headers);
