import { join } from 'node:path';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { REPO } from './app';
import { startService, stop, until, type Started } from './process';

const url = new URL(TEST_DATABASE_URL);
/** Credenciales de la base de pruebas, como variables del servicio que se lanza. */
export const dbEnv = {
  DB_HOST: url.hostname,
  DB_PORT: url.port || '5432',
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
/** Secreto SINTÉTICO del callback del conector `mock` (el mismo que verifica este servicio en sandbox). */
export const MOCK_SECRET = process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET as string;

export interface Bank {
  readonly started: Started;
  readonly base: string;
  readonly db: IsolatedDatabase;
}

export interface BankOptions {
  readonly callbackPort?: number;
  readonly secret?: string;
  readonly payerMode?: 'auto' | 'manual';
  readonly deliveryMs?: number;
  readonly hangMs?: number;
  readonly delayMs?: number;
  readonly qrUrl?: string;
}

/**
 * Lanza servicios HERMANOS como procesos reales (`dist/main.js` de pay-mockbank, pay-qr) con una base propia aislada cada uno, y los baja al terminar.
 * Solo se ejecutan sus binarios: no se importa su código ni se lee su base.
 */
export class Launcher {
  private readonly databases: IsolatedDatabase[] = [];
  private readonly processes: Started[] = [];

  track(resource: IsolatedDatabase | Started): void {
    if ('drop' in resource) this.databases.push(resource);
    else this.processes.push(resource);
  }

  /** Levanta el pay-mockbank real. `callbackPort` es el del servicio que recibe los callbacks. */
  async startBank(port: number, options: BankOptions = {}): Promise<Bank> {
    const db = await createIsolatedDatabase([join(REPO, 'services/pay-mockbank/sql/001_mockbank.sql')]);
    this.track(db);
    const started = startService(
      {
        ...dbEnv,
        PGOPTIONS: `-c search_path=${db.schema}`,
        PORT: String(port),
        PAY_MODE: 'sandbox',
        MOCKBANK_WEBHOOK_SECRET: options.secret ?? MOCK_SECRET,
        ...(options.callbackPort !== undefined && { MOCKBANK_CALLBACK_URL: `http://127.0.0.1:${options.callbackPort}/callbacks/mock` }),
        MOCKBANK_DELIVERY_INTERVAL_MS: String(options.deliveryMs ?? 50),
        MOCKBANK_PAYER_MODE: options.payerMode ?? 'auto',
        MOCKBANK_HANG_MS: String(options.hangMs ?? 1500),
        MOCKBANK_DELAY_MS: String(options.delayMs ?? 400),
        ...(options.qrUrl && { PAY_QR_URL: options.qrUrl }),
      },
      'pay-mockbank',
    );
    this.track(started);
    const base = `http://127.0.0.1:${port}`;
    const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, started.exited);
    if (!ready) throw new Error(`pay-mockbank no llegó a estar listo:\n${started.output()}`);
    return { started, base, db };
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.processes.map(stop));
    for (const db of this.databases) await db.drop();
  }
}
