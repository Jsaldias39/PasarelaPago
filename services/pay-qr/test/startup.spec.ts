import { join } from 'node:path';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { loadConfig } from '../src/config';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// Arranque REAL (`node dist/main.js`, entorno armado desde cero): `PAY_MODE` explícito y sin GUID de pruebas bajo `live` (D-26).
// Los casos de fallo salen antes de abrir la base; los de éxito usan un esquema aislado de Postgres real (PGOPTIONS).
const SQL = [join(process.cwd(), 'sql/ddl.sql')];
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_HOST: url.hostname,
  DB_PORT: url.port || '5432',
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
const REAL_LOOKING_GUID = 'bo.entidad.0001';
const started: Started[] = [];
let db: IsolatedDatabase;

beforeAll(async () => {
  buildService();
  db = await createIsolatedDatabase(SQL);
}, 240_000);
afterAll(async () => {
  await Promise.all(started.map(stop));
  await db.drop();
});

/** El servicio tiene que terminar solo, con código distinto de cero y nombrando el problema (un proceso terminado no escucha en ningún puerto). */
async function refuses(env: Record<string, string | undefined>, message: RegExp): Promise<void> {
  const service = startService({ ...dbEnv, PORT: '3198', ...env });
  started.push(service);
  let timer: NodeJS.Timeout | undefined;
  const code = await Promise.race([service.exited, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), 30_000)))]);
  clearTimeout(timer);
  expect(code).not.toBe('timeout');
  expect(code).not.toBe(0);
  expect(service.output()).toMatch(message);
}

/** Arranca de verdad: `/health/ready` responde 200 contra la base aislada. */
async function boots(env: Record<string, string | undefined>): Promise<void> {
  const port = await freePort();
  const service = startService({ ...dbEnv, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), ...env });
  started.push(service);
  const ready = await until(async () => ((await fetch(`http://127.0.0.1:${port}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
}

describe('PAY_MODE: explícito, sin valor por defecto', () => {
  it('inválido: sin definir, vacío o mal escrito NO arranca (ninguno cae en live ni en sandbox)', async () => {
    for (const mode of [undefined, '', 'LIVE', 'Sandbox', 'prod', 'production', 'test', 'live ', 'sandbox,live']) {
      await refuses({ PAY_MODE: mode, QR_ACCOUNT_GUID: REAL_LOOKING_GUID }, /PAY_MODE debe ser sandbox o live/);
    }
  });

  it('correcto: sandbox con el GUID provisional arranca', async () => {
    await boots({ PAY_MODE: 'sandbox', QR_ACCOUNT_GUID: 'guid.provisional' });
  }, 90_000);
});

describe('PAY_MODE=live se niega a arrancar con un GUID de pruebas', () => {
  it('inválido: provisional, sandbox, e2e o simulado NO arrancan bajo live; sin GUID tampoco', async () => {
    for (const guid of ['guid.provisional', 'e2e.sandbox.guid', 'GUID.PROVISIONAL', 'banco-simulado']) {
      await refuses({ PAY_MODE: 'live', QR_ACCOUNT_GUID: guid }, /PAY_MODE=live no admite un QR_ACCOUNT_GUID provisional/);
    }
    await refuses({ PAY_MODE: 'live' }, /Falta la variable de entorno QR_ACCOUNT_GUID/);
    await refuses({ PAY_MODE: 'live', QR_ACCOUNT_GUID: '' }, /Falta la variable de entorno QR_ACCOUNT_GUID/);
  });

  it('límite: el mismo GUID provisional sí vale en sandbox (loadConfig)', () => {
    const env = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p', QR_ACCOUNT_GUID: 'e2e.sandbox.guid' };
    expect(loadConfig({ ...env, PAY_MODE: 'sandbox' }).qr.accountGuid).toBe('e2e.sandbox.guid');
    expect(() => loadConfig({ ...env, PAY_MODE: 'live' })).toThrow(/PAY_MODE=live/);
  });

  it('correcto: live con un GUID que no es de pruebas arranca', async () => {
    expect(loadConfig({ DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p', PAY_MODE: 'live', QR_ACCOUNT_GUID: REAL_LOOKING_GUID }).mode).toBe('live');
    await boots({ PAY_MODE: 'live', QR_ACCOUNT_GUID: REAL_LOOKING_GUID });
  }, 90_000);
});
