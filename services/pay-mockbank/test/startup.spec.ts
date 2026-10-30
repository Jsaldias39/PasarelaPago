import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { SQL } from './support/app';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// P4.H4.M5 con el binario REAL (`node dist/main.js`, entorno armado desde cero): con PAY_MODE=live (o sin definir, o mal escrito) el servicio NO carga y el
// arranque falla; en sandbox arranca y TODA respuesta lleva `X-Pay-Mode: sandbox`.
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_HOST: url.hostname,
  DB_PORT: url.port || '5432',
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
const SECRET = { MOCKBANK_WEBHOOK_SECRET: 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==' };
const started: Started[] = [];
let db: IsolatedDatabase;

beforeAll(async () => {
  buildService('pay-mockbank');
  db = await createIsolatedDatabase(SQL);
}, 240_000);
afterAll(async () => {
  await Promise.all(started.map(stop));
  await db.drop();
});

async function refuses(env: Record<string, string | undefined>, message: RegExp): Promise<void> {
  const service = startService('pay-mockbank', { ...dbEnv, PORT: '3197', ...env });
  started.push(service);
  let timer: NodeJS.Timeout | undefined;
  const code = await Promise.race([service.exited, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), 30_000)))]);
  clearTimeout(timer);
  expect(code).not.toBe('timeout');
  expect(code).not.toBe(0);
  expect(service.output()).toMatch(message);
}

describe('PAY_MODE: pay-mockbank solo existe en sandbox', () => {
  it('live NO carga: el proceso termina con código ≠ 0 y lo dice', async () => {
    await refuses({ PAY_MODE: 'live', ...SECRET }, /PAY_MODE=live: pay-mockbank es un banco simulado y no existe en producción/);
  });

  it('inválido: sin definir, vacío o mal escrito NO arranca (ninguno cae en sandbox por accidente)', async () => {
    // Procesos independientes: en paralelo (nueve arranques en serie pasaban de los 20 s del tiempo de la prueba con la máquina cargada).
    await Promise.all([undefined, '', 'LIVE', 'Sandbox', 'prod', 'test', 'sandbox ', 'sandbox,live'].map((mode) => refuses({ PAY_MODE: mode, ...SECRET }, /PAY_MODE debe ser sandbox/)));
  });

  it('inválido: sin el secreto de los callbacks, o con parámetros mal formados, tampoco arranca', async () => {
    await refuses({ PAY_MODE: 'sandbox' }, /Falta la variable de entorno MOCKBANK_WEBHOOK_SECRET/);
    await refuses({ PAY_MODE: 'sandbox', ...SECRET, MOCKBANK_PAYER_MODE: 'siempre' }, /MOCKBANK_PAYER_MODE/);
    await refuses({ PAY_MODE: 'sandbox', ...SECRET, MOCKBANK_DELAY_MS: '0' }, /MOCKBANK_DELAY_MS inválido/);
    await refuses({ PAY_MODE: 'sandbox', ...SECRET, DB_HOST: undefined }, /DB_HOST/);
  });

  it('correcto: en sandbox arranca y TODA respuesta (salud, 403, 404) lleva X-Pay-Mode: sandbox', async () => {
    const port = await freePort();
    const service = startService('pay-mockbank', { ...dbEnv, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), PAY_MODE: 'sandbox', ...SECRET });
    started.push(service);
    const base = `http://127.0.0.1:${port}`;
    const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
    if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
    const responses = [
      await fetch(`${base}/health/live`, { headers: { connection: 'close' } }),
      await fetch(`${base}/sandbox/charges`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body: '{}' }),
      await fetch(`${base}/ruta/inexistente`, { headers: { connection: 'close', 'x-service-id': 'pay-connectors' } }),
      await fetch(`${base}/sandbox/probe`, { headers: { connection: 'close', 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test' } }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 404, 200]);
    for (const response of responses) {
      expect(response.headers.get('x-pay-mode')).toBe('sandbox');
      await response.arrayBuffer();
    }
  }, 90_000);
});
