import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, loadState, mandateDescription, remoteTarget, runSeed, SEED_MANDATES, SEED_MARK, SEED_MERCHANTS, saveState, walletReference, type SeedDeps, type SeedMerchantSpec } from './sandbox-seed.ts';
import type { SeededMerchant } from './seed.ts';

/** Un «mundo» en memoria con el contrato de `SeedDeps`: cuenta lo que se crea de verdad, como lo haría la base. */
function fakeWorld() {
  const merchants = new Map<string, SeededMerchant & { ref: string }>();
  const openings = new Set<string>();
  const mandates: { id: string; description: string; token: string; status: string }[] = [];
  let sequence = 0;
  const calls = { onboard: 0, fund: 0, createMandate: 0 };
  const deps: SeedDeps = {
    merchantExists: async (id) => merchants.has(id),
    onboard: async (spec: SeedMerchantSpec) => {
      calls.onboard += 1;
      sequence += 1;
      const created = { merchantId: `mc_sbx${String(sequence).padStart(8, '0')}`, keyId: `key_sbx${sequence}aaaaaaa`, token: `sk_test_sbx${sequence}_${spec.ref}`, ref: spec.ref };
      merchants.set(created.merchantId, created);
      return created;
    },
    fundWallet: async (_merchantId, _amount, reference) => {
      calls.fund += 1;
      if (openings.has(reference)) return false;
      openings.add(reference);
      return true;
    },
    findMandate: async (token, description) => mandates.find((m) => m.token === token && m.description === description && m.status !== 'canceled')?.id,
    createMandate: async (token, body) => {
      calls.createMandate += 1;
      sequence += 1;
      const id = `md_sbx${String(sequence).padStart(8, '0')}`;
      mandates.push({ id, description: String((body as { description: string }).description), token, status: 'active' });
      return id;
    },
  };
  return { deps, merchants, openings, mandates, calls };
}

const total = (counts: object) => Object.values(counts as Record<string, number>).reduce((a, b) => a + b, 0);

describe('siembra sintética de sandbox — nivel CORRECTO: la primera corrida siembra todo y la SEGUNDA inserta 0', () => {
  it('crea los 3 comercios con su clave, las 2 billeteras con saldo y el mandato; la segunda corrida no inserta nada', async () => {
    const world = fakeWorld();
    const state = emptyState();
    const first = await runSeed(world.deps, state, () => undefined);
    expect(first.inserted).toEqual({ merchants: 3, api_keys: 3, wallets: 2, mandates: 1 });
    expect(total(first.reused)).toBe(0);
    expect(Object.keys(state.merchants).sort()).toEqual(['medico', 'proveedor', 'taller']);

    const callsBefore = { ...world.calls };
    const second = await runSeed(world.deps, state, () => undefined);
    expect(second.inserted).toEqual({ merchants: 0, api_keys: 0, wallets: 0, mandates: 0 });
    expect(second.reused).toEqual({ merchants: 3, api_keys: 3, wallets: 2, mandates: 1 });
    expect(world.calls.onboard).toBe(callsBefore.onboard); // no se dio de alta nada más
    expect(world.calls.createMandate).toBe(callsBefore.createMandate);
    expect(world.mandates).toHaveLength(1);
  });

  it('todo lo sembrado se DECLARA sintético: nombres con (SINTÉTICO), NIT SBX, asientos y mandatos con la marca', () => {
    for (const spec of SEED_MERCHANTS) {
      expect(spec.label).toMatch(/\(SINTÉTICO\)$/);
      expect(spec.taxId).toMatch(/^SBX/);
    }
    expect(walletReference('medico')).toMatch(/^sandbox-seed:opening:/);
    for (const spec of SEED_MANDATES) expect(mandateDescription(spec)).toContain(SEED_MARK);
  });
});

describe('siembra sintética de sandbox — nivel LÍMITE', () => {
  it('si se borró la base (el comercio ya no existe) se vuelve a crear solo ese; los demás se reusan', async () => {
    const world = fakeWorld();
    const state = emptyState();
    await runSeed(world.deps, state, () => undefined);
    world.merchants.delete(state.merchants.taller!.merchantId);
    const again = await runSeed(world.deps, state, () => undefined);
    expect(again.inserted.merchants).toBe(1);
    expect(again.reused.merchants).toBe(2);
    expect(Object.keys(state.merchants)).toHaveLength(3);
  });

  it('un corte a mitad de la siembra: la corrida siguiente continúa sin duplicar lo ya hecho', async () => {
    const world = fakeWorld();
    const state = emptyState();
    const saved: number[] = [];
    let crashAfter = 4; // tras 4 pasos guardados
    const crashing = { ...world.deps, createMandate: world.deps.createMandate };
    await expect(
      runSeed(crashing, state, () => {
        saved.push(1);
        if (saved.length === crashAfter) {
          crashAfter = -1;
          throw new Error('corte');
        }
      }),
    ).rejects.toThrow('corte');
    const resumed = await runSeed(world.deps, state, () => undefined);
    expect(world.merchants.size).toBe(3); // 3 comercios, no 4
    expect(world.mandates).toHaveLength(1);
    expect(resumed.inserted.merchants + resumed.reused.merchants).toBe(3);
  });

  it('un mandato cancelado no cuenta como sembrado: se crea otro', async () => {
    const world = fakeWorld();
    const state = emptyState();
    await runSeed(world.deps, state, () => undefined);
    world.mandates[0]!.status = 'canceled';
    const again = await runSeed(world.deps, state, () => undefined);
    expect(again.inserted.mandates).toBe(1);
    expect(world.mandates).toHaveLength(2);
  });

  it('el estado en disco guarda las claves con modo 0600 y se relee igual', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    try {
      const file = join(dir, 'sub', 'seed-state.json');
      const state = emptyState();
      state.merchants.taller = { merchantId: 'mc_x', keyId: 'key_x', token: 'sk_test_x' };
      saveState(file, state);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadState(file)).toEqual(state);
      expect(loadState(join(dir, 'no-existe.json'))).toEqual(emptyState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('siembra sintética de sandbox — nivel INVÁLIDO', () => {
  it('si el alta falla, el error sale y NO queda un comercio a medias en el estado', async () => {
    const world = fakeWorld();
    const state = emptyState();
    const failing: SeedDeps = { ...world.deps, onboard: async () => Promise.reject(new Error('pay-merchants respondió 503')) };
    await expect(runSeed(failing, state, () => undefined)).rejects.toThrow('503');
    expect(state.merchants).toEqual({});
  });

  it('si falta en el estado el comercio beneficiario, se vuelve a dar de alta ANTES del mandato (nunca se inventa un id)', async () => {
    const world = fakeWorld();
    const state = emptyState();
    await runSeed(world.deps, state, () => undefined);
    delete state.merchants.proveedor;
    world.merchants.clear();
    const broken: SeedDeps = { ...world.deps, merchantExists: async () => true };
    await expect(runSeed(broken, state, () => undefined)).resolves.toBeDefined(); // el proveedor se vuelve a dar de alta antes del mandato
    expect(state.merchants.proveedor).toBeDefined();
  });

  it('la versión de estado desconocida se rechaza en vez de interpretarse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    try {
      const file = join(dir, 's.json');
      saveState(file, { ...emptyState(), version: 2 as unknown as 1 });
      expect(() => loadState(file)).toThrow(/versión de estado desconocida/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remoteTarget — la identidad interna que manda hacia las APIs reales', () => {
  it('arma X-Service-Id, X-Pay-Mode y X-Merchant-Id como el arnés y no manda X-Pay-Mode cuando se pide null', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      seen.push({ ...req.headers, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const target = remoteTarget({ merchants: url, edge: url, ledger: url }, 'pem');
      const res = await target.callAs('pay-payments', 'pay-ledger', 'GET', '/balances?account=x', { merchantId: 'mc_abc', payMode: 'test' });
      await target.callAs('pay-backoffice', 'pay-merchants', 'GET', '/merchants/mc_abc', { payMode: null });
      expect(res.status).toBe(200);
      expect(seen[0]).toMatchObject({ 'x-service-id': 'pay-payments', 'x-pay-mode': 'test', 'x-merchant-id': 'mc_abc' });
      expect(seen[1]!['x-pay-mode']).toBeUndefined();
      expect(seen[1]!['x-service-id']).toBe('pay-backoffice');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
