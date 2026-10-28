import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../lib/infra.ts';
import { serviceDb } from '../lib/db.ts';
import { SEED_LEGAL_NAME, SEED_MANDATES, SEED_MARK, SEED_MERCHANTS, walletReference, type SeedCounts, type SeedState } from '../lib/sandbox-seed.ts';
import { OPERATOR_ISSUER } from '../lib/services.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

const run = promisify(execFile);

/**
 * `yarn seed:sandbox` (P1.H5.M2) contra el stack REAL de 12 servicios del arnés. El Compose de la capa sandbox no se puede levantar acá (ver docs/trabajo/ola-4/P1/BLOQUEOS.md), así que
 * la siembra corre por su MISMA entrada (`e2e/seed-sandbox.ts`, como proceso hijo) apuntada a los puertos del arnés con `SANDBOX_*_URL`, con un `SANDBOX_DIR` TEMPORAL (la clave
 * del operador sintético y el estado con las `sk_test_` van ahí; `platform/.sandbox` no se toca). La credencial de operador es la del arnés (`OPERATOR_ISSUER`), no la de Compose.
 *
 * Correcto: la 1ª corrida inserta (3 comercios, 3 claves, 2 billeteras, 1 mandato) y la 2ª inserta 0 y reutiliza todo; lo sembrado queda DECLARADO sintético (nombres «(SINTÉTICO)», NIT `SBX…`,
 * marca en asientos y mandato); las claves `sk_test_` autentican en pay-edge (200 con el comercio correcto).
 * Límite: tras DOS corridas hay exactamente UN asiento de apertura por billetera (saldo = apertura, no el doble), UN mandato y los mismos ids; el estado queda en 0600.
 * Inválido: la clave de OTRO comercio no ve el recurso (404/403), una clave inventada y la ausencia de clave dan 401; sin la clave del operador la siembra se niega (exit 2) sin tocar nada.
 */
describe('seed:sandbox contra el stack real de 12 servicios', () => {
  let stack: Stack;
  let dir: string;
  let first: { declaracion: string; inserted: SeedCounts; reused: SeedCounts };
  let second: { declaracion: string; inserted: SeedCounts; reused: SeedCounts };
  let stateAfterFirst: SeedState;
  let stateAfterSecond: SeedState;
  const stateFile = () => join(dir, 'seed-state.json');

  const seed = async (extraEnv: Record<string, string> = {}, directory = dir) => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SANDBOX_MERCHANTS_URL: stack.url('pay-merchants'),
      SANDBOX_EDGE_URL: stack.url('pay-edge'),
      SANDBOX_LEDGER_URL: stack.url('pay-ledger'),
      SANDBOX_OPERATOR_ISSUER: OPERATOR_ISSUER,
      SANDBOX_DIR: directory,
      ...extraEnv,
    };
    try {
      const { stdout } = await run(process.execPath, ['--no-warnings', join(ROOT, 'e2e/seed-sandbox.ts')], { cwd: ROOT, env, timeout: 240_000 });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  const edge = (token: string | undefined, method: string, path: string) =>
    stack.call('pay-edge', method, path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const merchantsOf = (state: SeedState) => Object.entries(state.merchants);
  const tokenOf = (ref: string) => stateAfterSecond.merchants[ref]!.token;
  const balance = async (merchantId: string) => {
    const res = await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/balances?account=${encodeURIComponent(`merchant:${merchantId}:available`)}`, { payMode: 'test' });
    return res.status === 404 ? 0 : (res.json as { balance_minor: number }).balance_minor;
  };

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, mockbank: true });
    dir = mkdtempSync(join(tmpdir(), 'seed-sandbox-e2e-'));
    writeFileSync(join(dir, 'operator-private.pem'), stack.secrets.operatorPrivateKeyPem, { mode: 0o600 });
  }, 600_000);
  afterAll(async () => {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } finally {
      if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
    }
  });

  it('el stack tiene los 12 servicios sanos', () => {
    const healthy = Object.values(stack.services).filter((s) => s.started && s.healthy);
    expect(healthy).toHaveLength(12);
  });

  it('CORRECTO: la 1ª corrida inserta 3 comercios, 3 claves, 2 billeteras y 1 mandato, y se declara SINTÉTICA', async () => {
    const result = await seed();
    if (result.code !== 0) throw new Error(`seed:sandbox salió con ${result.code}: ${result.stderr}`);
    process.stdout.write(`seed:sandbox corrida 1 (salida literal):\n${result.stdout}`);
    first = JSON.parse(result.stdout) as typeof first;
    stateAfterFirst = JSON.parse(readFileSync(stateFile(), 'utf8')) as SeedState;
    expect(first.declaracion).toMatch(/SINTÉTICA.*ningún dato es real/);
    expect(first.inserted).toEqual({ merchants: SEED_MERCHANTS.length, api_keys: SEED_MERCHANTS.length, wallets: SEED_MERCHANTS.filter((m) => m.walletMinor > 0).length, mandates: SEED_MANDATES.length });
    expect(first.inserted.merchants).toBeGreaterThan(0);
    expect(first.reused).toEqual({ merchants: 0, api_keys: 0, wallets: 0, mandates: 0 });
  });

  it('CORRECTO: la 2ª corrida inserta 0 y reutiliza todo, con los mismos ids y las mismas claves', async () => {
    const result = await seed();
    if (result.code !== 0) throw new Error(`seed:sandbox salió con ${result.code}: ${result.stderr}`);
    process.stdout.write(`seed:sandbox corrida 2 (salida literal):\n${result.stdout}`);
    second = JSON.parse(result.stdout) as typeof second;
    stateAfterSecond = JSON.parse(readFileSync(stateFile(), 'utf8')) as SeedState;
    expect(second.inserted).toEqual({ merchants: 0, api_keys: 0, wallets: 0, mandates: 0 });
    expect(second.reused).toEqual(first.inserted);
    expect(stateAfterSecond.merchants).toEqual(stateAfterFirst.merchants);
    expect(stateAfterSecond.mandates).toEqual(stateAfterFirst.mandates);
  });

  it('LÍMITE: tras DOS corridas hay UN asiento de apertura por billetera (saldo = apertura), UN mandato, y el estado con las claves está en modo 0600', async () => {
    for (const spec of SEED_MERCHANTS) {
      const merchantId = stateAfterSecond.merchants[spec.ref]!.merchantId;
      expect(await balance(merchantId)).toBe(spec.walletMinor); // si la 2ª corrida hubiera cargado otra vez, sería el doble
      if (spec.walletMinor > 0) {
        const lines = await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/statements?account=${encodeURIComponent(`merchant:${merchantId}:available`)}&limit=100`, { payMode: 'test' });
        const own = (lines.json as { data: { business_ref: string; direction: string; amount_minor: number }[] }).data.filter((l) => l.business_ref === `${merchantId}:${walletReference(spec.ref)}`);
        expect(own).toHaveLength(1);
        expect(own[0]).toMatchObject({ direction: 'credit', amount_minor: spec.walletMinor });
      }
    }
    const payer = SEED_MANDATES[0]!.payer;
    const list = await edge(tokenOf(payer), 'GET', '/v1/mandates?limit=100');
    expect(list.status).toBe(200);
    const mandates = (list.json as { data: { id: string; description?: string; status: string }[] }).data.filter((m) => m.description?.startsWith(SEED_MARK));
    expect(mandates).toHaveLength(1);
    expect(mandates[0]!.id).toBe(stateAfterSecond.mandates[SEED_MANDATES[0]!.ref]!.mandateId);
    expect((statSync(stateFile()).mode & 0o777).toString(8)).toBe('600');
  });

  it('CORRECTO: TODO lo sembrado está declarado sintético (nombres, NIT SBX…, marca en el mandato) en los servicios reales', async () => {
    for (const spec of SEED_MERCHANTS) {
      const { merchantId, token } = stateAfterSecond.merchants[spec.ref]!;
      const me = await edge(token, 'GET', '/v1/merchants/me');
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({ id: merchantId, display_name: expect.stringContaining('(SINTÉTICO)') });
      // El back-office no expone NIT ni razón social; se leen de la base de pay-merchants (solo lectura).
      const row = (await serviceDb(stack, 'merchants', (db) => db.query('SELECT display_name, legal_name, tax_id FROM merchants WHERE id = $1', [merchantId]))).rows;
      expect(row).toEqual([{ display_name: spec.label, legal_name: SEED_LEGAL_NAME, tax_id: spec.taxId }]);
      expect(spec.taxId).toMatch(/^SBX/);
      expect(spec.label).toContain('(SINTÉTICO)');
      expect(token).toMatch(/^sk_test_/);
    }
    const list = await edge(tokenOf(SEED_MANDATES[0]!.payer), 'GET', '/v1/mandates?limit=100');
    const mandate = (list.json as { data: { id: string; description: string; status: string }[] }).data.find((m) => m.id === stateAfterSecond.mandates[SEED_MANDATES[0]!.ref]!.mandateId);
    expect(mandate).toMatchObject({ description: `${SEED_MARK} ${SEED_MANDATES[0]!.ref}`, status: expect.stringMatching(/^(active|scheduled|pending)$/) });
    for (const spec of SEED_MERCHANTS.filter((m) => m.walletMinor > 0)) expect(walletReference(spec.ref)).toMatch(/^sandbox_seed_opening_/);
  });

  it('CORRECTO: las claves sk_test_ sembradas autentican en pay-edge: un GET autenticado devuelve 200 con SU comercio', async () => {
    for (const [ref, { merchantId, token }] of merchantsOf(stateAfterSecond)) {
      const me = await until(`el borde conoce a ${ref}`, () => edge(token, 'GET', '/v1/merchants/me'), (r) => r.status === 200, 30_000, 250);
      expect((me.json as { id: string }).id).toBe(merchantId);
      expect((await edge(token, 'GET', '/v1/balance')).status).toBe(200);
    }
    const balance = await edge(tokenOf('medico'), 'GET', '/v1/balance');
    expect((balance.json as { available_minor: number }).available_minor).toBe(500_000);
  });

  it('INVÁLIDO: la clave de OTRO comercio no toca lo ajeno (403/404 al cancelar el mandato y al leer un cobro), y una clave inventada o la falta de clave dan 401', async () => {
    const mandateId = stateAfterSecond.mandates[SEED_MANDATES[0]!.ref]!.mandateId;
    const ownerList = async () => (((await edge(tokenOf('medico'), 'GET', '/v1/mandates?limit=100')).json as { data: { id: string; status: string }[] }).data.find((m) => m.id === mandateId));
    const before = await ownerList();
    expect(before).toBeDefined(); // control positivo: el dueño sí lo ve
    for (const other of ['taller', 'proveedor']) {
      expect([403, 404]).toContain((await stack.call('pay-edge', 'DELETE', `/v1/mandates/${mandateId}`, { headers: { authorization: `Bearer ${tokenOf(other)}`, 'idempotency-key': `seed-e2e-cancel-${other}-0001` } })).status);
      const otherList = (await edge(tokenOf(other), 'GET', '/v1/mandates?limit=100')).json as { data: { id: string }[] };
      expect(otherList.data.map((m) => m.id)).not.toContain(mandateId);
    }
    expect(await ownerList()).toEqual(before); // nadie lo canceló
    // Un cobro del comercio «medico» no lo ve otro comercio.
    const intent = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { authorization: `Bearer ${tokenOf('medico')}`, 'idempotency-key': 'seed-e2e-intent-0001' }, json: { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' } } });
    expect(intent.status).toBe(201);
    const intentId = (intent.json as { id: string }).id;
    expect((await edge(tokenOf('medico'), 'GET', `/v1/payment_intents/${intentId}`)).status).toBe(200);
    for (const other of ['taller', 'proveedor']) expect([403, 404]).toContain((await edge(tokenOf(other), 'GET', `/v1/payment_intents/${intentId}`)).status);
    expect((await edge('sk_test_inventada0000000000000000000000', 'GET', '/v1/merchants/me')).status).toBe(401);
    expect((await edge(undefined, 'GET', '/v1/merchants/me')).status).toBe(401);
  });

  it('INVÁLIDO: sin la clave del operador sintético la siembra se niega (exit 2) y contra un destino que no es de esta máquina también, sin sembrar nada', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'seed-sandbox-e2e-vacio-'));
    try {
      const noKey = await seed({}, empty);
      expect(noKey.code).toBe(2);
      expect(noKey.stderr).toContain('operator-private.pem');
      expect(existsSync(join(empty, 'seed-state.json'))).toBe(false);
      const remote = await seed({ SANDBOX_EDGE_URL: 'http://pasarela.example.com:3101' });
      expect(remote.code).toBe(2);
      expect(remote.stderr).toContain('no son de esta máquina');
      const live = await seed({ PAY_MODE: 'live' });
      expect(live.code).toBe(2);
      expect(live.stderr).toContain('PAY_MODE=live');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
