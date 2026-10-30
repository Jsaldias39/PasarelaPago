import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { SQL } from './support/app';

// Arranque REAL (`node dist/main.js`, entorno armado desde cero): `PAY_MODE` explícito y sin dobles bajo `live` (D-26).
// Los casos de fallo salen antes de abrir la base; los de éxito usan un esquema aislado de Postgres real (PGOPTIONS).
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_HOST: url.hostname,
  DB_PORT: url.port || '5432',
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
// Bajo live el proveedor de secretos es explícito (P4.H2.M6): solo `openbao`, con https. No se conecta al arrancar: la dirección es sintética.
const LIVE_SECRETS = { SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://openbao.invalid:8200', OPENBAO_TOKEN: 'tok-sintetico-de-prueba' };
// Bajo live el servicio también exige `IDEMPOTENCY_MASK_KEY` (≥32 bytes, S-02): el almacén de idempotencia se construye al arrancar. Valor sintético de prueba.
const LIVE_MASK_KEY = { IDEMPOTENCY_MASK_KEY: 'clave-sintetica-de-prueba-0123456789abcdef' };
const MOCK_SECRET = { PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==' };
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
  const service = startService({ ...dbEnv, PORT: '3199', ...env });
  started.push(service);
  let timer: NodeJS.Timeout | undefined;
  const code = await Promise.race([service.exited, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), 30_000)))]);
  clearTimeout(timer);
  expect(code).not.toBe('timeout');
  expect(code).not.toBe(0);
  expect(service.output()).toMatch(message);
}

/** Arranca de verdad: responde `/health/live` y `/health/ready`. */
async function boots(env: Record<string, string | undefined>): Promise<{ service: Started; port: number }> {
  const port = await freePort();
  const service = startService({ ...dbEnv, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), POLLER_INTERVAL_MS: '0', HEALTH_INTERVAL_MS: '0', RECONCILE_INTERVAL_MS: '0', ...env });
  started.push(service);
  const ready = await until(async () => ((await fetch(`http://127.0.0.1:${port}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
  return { service, port };
}

/** Códigos de los conectores que el proceso tiene cargados (`GET /connectors/health`). */
async function connectorsHealth(port: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/connectors/health`, { headers: { 'x-service-id': 'pay-payments', connection: 'close' } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<{ connector: string }> };
  return body.data.map((entry) => entry.connector);
}

describe('PAY_MODE: explícito, sin valor por defecto', () => {
  it('inválido: sin definir, vacío o mal escrito NO arranca (ninguno cae en live ni en sandbox)', async () => {
    // Procesos independientes: en paralelo (nueve arranques en serie pasaban de los 20 s del tiempo de la prueba con la máquina cargada).
    await Promise.all([undefined, '', 'LIVE', 'Sandbox', 'prod', 'production', 'test', 'live ', 'sandbox,live'].map((mode) => refuses({ PAY_MODE: mode, ...MOCK_SECRET }, /PAY_MODE debe ser sandbox o live/)));
  });

  it('correcto: sandbox arranca, y lo informa (conector mock cargado)', async () => {
    const { port } = await boots({ PAY_MODE: 'sandbox', ...MOCK_SECRET });
    expect((await connectorsHealth(port)).sort()).toEqual(['bank_transfer', 'mock']);
  }, 90_000);
});

describe('PAY_MODE=live se niega a arrancar con conector mock o doble configurado', () => {
  it('inválido: el secreto del simulador, su bomba de callbacks o una cuenta con rótulo SANDBOX', async () => {
    await refuses({ PAY_MODE: 'live', ...MOCK_SECRET }, /PAY_MODE=live no admite.*PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET/);
    await refuses({ PAY_MODE: 'live', MOCK_PUMP_INTERVAL_MS: '1000' }, /PAY_MODE=live no admite.*MOCK_PUMP_INTERVAL_MS/);
    // El banco simulado de la capa sandbox (pay-mockbank) tampoco entra en live: ni su URL ni su timeout.
    await refuses({ PAY_MODE: 'live', MOCKBANK_URL: 'http://127.0.0.1:3112' }, /PAY_MODE=live no admite.*MOCKBANK_URL/);
    await refuses({ PAY_MODE: 'live', MOCKBANK_TIMEOUT_MS: '500' }, /PAY_MODE=live no admite.*MOCKBANK_TIMEOUT_MS/);
    await refuses({ PAY_MODE: 'live', MOCK_PUMP_INTERVAL_MS: '0' }, /MOCK_PUMP_INTERVAL_MS/);
    await refuses({ PAY_MODE: 'live', BANK_TRANSFER_BANK_NAME: 'BANCO SIMULADO (SANDBOX)', BANK_TRANSFER_ACCOUNT_HOLDER: 'ALOVIDA PAY (SANDBOX)', BANK_TRANSFER_ACCOUNT_NUMBER: 'SANDBOX-0000-0001' }, /PAY_MODE=live no admite.*BANK_TRANSFER_BANK_NAME/);
  });

  it('límite: la cuenta a medias bajo live tampoco arranca, ni siquiera sin dobles', async () => {
    await refuses({ PAY_MODE: 'live', BANK_TRANSFER_BANK_NAME: 'Banco X', ...LIVE_SECRETS }, /van los tres o ninguno/);
  });

  it('inválido: live sin SECRET_PROVIDER, con `env` o con OpenBao por http NO arranca (sin proveedor por defecto)', async () => {
    await refuses({ PAY_MODE: 'live' }, /SECRET_PROVIDER es obligatorio bajo PAY_MODE=live/);
    await refuses({ PAY_MODE: 'live', SECRET_PROVIDER: 'env' }, /no admite SECRET_PROVIDER=env/);
    await refuses({ PAY_MODE: 'live', ...LIVE_SECRETS, OPENBAO_ADDR: 'http://openbao.invalid:8200' }, /https bajo PAY_MODE=live/);
    await refuses({ PAY_MODE: 'live', SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://openbao.invalid:8200' }, /Falta la credencial de OpenBao/);
  });

  it('inválido: live sin IDEMPOTENCY_MASK_KEY (o con una corta, o la de desarrollo) NO arranca (S-02); en sandbox no se exige', async () => {
    await refuses({ PAY_MODE: 'live', ...LIVE_SECRETS }, /IDEMPOTENCY_MASK_KEY es obligatoria bajo PAY_MODE=live/);
    await refuses({ PAY_MODE: 'live', ...LIVE_SECRETS, IDEMPOTENCY_MASK_KEY: 'corta' }, /IDEMPOTENCY_MASK_KEY inválida/);
    await refuses({ PAY_MODE: 'live', ...LIVE_SECRETS, IDEMPOTENCY_MASK_KEY: 'dev-only-idempotency-mask-key-sandbox-0123456789' }, /clave de desarrollo/);
  }, 90_000);

  it('correcto: live limpio (sin mock, sin cuenta: T-03) arranca y NO carga ningún conector de sandbox', async () => {
    const { port } = await boots({ PAY_MODE: 'live', ...LIVE_SECRETS, ...LIVE_MASK_KEY });
    expect(await connectorsHealth(port)).toEqual([]);
  }, 90_000);
});
