import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { eventsOf, key, MC, seedMerchant, spawnWorker, startStack, statusOf, waitFor, type ChildWorker, type Stack } from './helpers/stack';

let stack: Stack;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const alive: ChildWorker[] = [];

beforeAll(async () => {
  // El worker corre desde `dist/`: se compila el código actual (si no, la prueba ejercitaría una versión vieja).
  execFileSync(process.execPath, [path.join(process.cwd(), '../../node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: process.cwd(), stdio: 'pipe' });
  stack = await startStack({ inProcessWorker: false, env: { ACTIVITY_TIMEOUT_MS: '4000', ACTIVITY_MAX_ATTEMPTS: '8', STATUS_INQUIRY_MS: '60000' } });
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await Promise.all(alive.map((w) => w.kill()));
  await stack.stop();
});

const worker = async (): Promise<ChildWorker> => {
  const w = spawnWorker(stack);
  alive.push(w);
  await w.ready;
  return w;
};

describe('REQ-P3-4 · matar el worker a mitad de la saga: el cobro termina en UN solo estado y con UN solo asiento', () => {
  it.each([1, 2, 3, 4, 5])('corrida %i: SIGKILL con el asiento del ledger en vuelo', async () => {
    const a = await worker();
    const created = await stack.service.createIntent(MC, key(), QR);
    const id = created.body.id as string;
    expect(created.body.status).toBe('requires_action');

    stack.ledger.latencyMs = 3000; // el asiento tarda: da tiempo a matar al worker mientras la activity está en vuelo
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await waitFor(async () => (stack.ledger.server.callsTo('POST', /^\/transactions$/).some((c) => JSON.stringify(c.body).includes(`${id}:capture`)) ? true : undefined), 15_000, 'la activity del ledger en vuelo');
    await a.kill();
    stack.ledger.latencyMs = 0;

    expect(await statusOf(stack, id)).toBe('processing'); // la saga quedó a medias: el estado no se adelantó
    const b = await worker();
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 60_000, 'el cobro se completa en el worker nuevo');

    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    const ends = (await eventsOf(stack, id)).filter((e) => /\.(succeeded|failed|canceled|expired)$/.test(e.type));
    expect(ends.map((e) => e.type)).toEqual(['payment_intent.succeeded']);
    await b.kill();
  });

  it('SIGKILL mientras el cobro espera al pagador: el aviso del banco llega con el worker caído y se procesa al volver', async () => {
    const a = await worker();
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    await a.kill();
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await stack.orchestrator.signalCharge(id, { status: 'captured' }); // la señal queda en el historial de Temporal
    expect(await statusOf(stack, id)).toBe('requires_action');
    const b = await worker();
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 60_000, 'se procesa la señal pendiente');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    await b.kill();
  });

  it('dos workers vivos a la vez (reparto de carga): la misma saga no se ejecuta dos veces', async () => {
    const [a, b] = [await worker(), await worker()];
    const ids = await Promise.all(Array.from({ length: 6 }, async () => (await stack.service.createIntent(MC, key(), QR)).body.id as string));
    for (const id of ids) {
      stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
      await stack.orchestrator.signalCharge(id, { status: 'captured' });
    }
    for (const id of ids) await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 60_000, `cobro ${id}`);
    for (const id of ids) expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    await Promise.all([a.kill(), b.kill()]);
  });
});
