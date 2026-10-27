import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { newCloudEvent } from '@pay/outbox';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { EventHandlers } from '../src/events/handlers';
import { assertNoDoublesInLive } from '../src/live-guard';
import { replicasRepo } from '../src/persistence/replicas.repo';
import { asMerchant, httpApp } from './helpers/http';
import { key, MC, QR_FEES, seedMerchant, startDirectIntent, startStack, statusOf, TEST_LEGAL_NAME, waitFor, type Stack } from './helpers/stack';

/** Tanda 2c: cribado D-29 (razón social del comercio + nombre del pagador), PAY_MODE explícito con guarda de dobles en `live`, y apagado limpio. */
let stack: Stack;
let app: INestApplication;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const http = () => request(app.getHttpServer());
const post = (merchantId = MC) => http().post('/payment_intents').set(asMerchant(merchantId)).set('idempotency-key', key()).send(QR);
const PAYER = 'Persona Sintetica Uno'; // sintético: ningún dato real
const BLOCKED_NAME = 'Entidad Sancionada de Prueba'; // sintético: es lo que el doble de pay-risk tiene en su lista
let seq = 0;
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const nextId = () => `pi_ola2c${String(Date.now()).slice(-7)}${String(seq++).padStart(3, '0')}`;
const callsFor = (intentId: string) => stack.risk.server.calls.filter((c) => (c.body as { payment_intent_id?: string }).payment_intent_id === intentId);
const screeningOf = (call: { body: unknown }) => (call.body as { screening?: { name: string; entity_type?: string } }).screening;
const keyOf = (call: { headers: Record<string, unknown> }) => String(call.headers['idempotency-key']);
const failureOf = async (id: string) => (await stack.db.pool.query('SELECT status, failure_code FROM payment_intents WHERE id = $1', [id])).rows[0] as { status: string; failure_code: string | null };
const chargeCreated = (id: string) => waitFor(async () => stack.connectors.chargeFor(id), 15_000, `cargo de ${id} en el conector`);

beforeAll(async () => {
  stack = await startStack();
  app = await httpApp(stack);
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.risk.mode = 'allow';
  stack.risk.requireScreening = true;
  stack.risk.sanctions.clear();
  stack.connectors.health = [{ connector: 'mock', mode: 'sandbox', status: 'up' }];
  stack.connectors.healthDown = false;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

describe('1 · D-29: se cribe la razón social del comercio y, si se da, el nombre del pagador', () => {
  it('correcto · comercio con razón social ⇒ UNA evaluación con screening {name, entity_type: business}; allow; el cobro sigue', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    const calls = callsFor(id);
    expect(calls).toHaveLength(1);
    expect(screeningOf(calls[0]!)).toEqual({ name: TEST_LEGAL_NAME, entity_type: 'business' });
    expect(keyOf(calls[0]!)).toBe(`${id}:risk`);
    expect(await chargeCreated(id)).toBeDefined();
    expect((await failureOf(id)).failure_code).toBeNull();
  });

  it('correcto · pagador con nombre ⇒ TAMBIÉN se cribe (segunda evaluación, entity_type person, clave propia); allow en las dos ⇒ el cobro sigue', async () => {
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000, payerName: PAYER });
    expect(await chargeCreated(id)).toBeDefined();
    const calls = callsFor(id);
    expect(calls.map((c) => screeningOf(c))).toEqual([{ name: TEST_LEGAL_NAME, entity_type: 'business' }, { name: PAYER, entity_type: 'person' }]);
    expect(calls.map(keyOf)).toEqual([`${id}:risk`, `${id}:risk:payer`]);
    expect((await failureOf(id)).failure_code).toBeNull();
  });

  it('límite · pagador invitado SIN nombre ⇒ no se manda nombre de pagador y el cobro NO se bloquea por eso', async () => {
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000 });
    expect(await chargeCreated(id)).toBeDefined();
    const calls = callsFor(id);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => screeningOf(c)?.entity_type === 'person')).toBe(false);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('"payer_name"');
    expect((await failureOf(id)).failure_code).toBeNull();
  });

  it('límite · un nombre con otras mayúsculas, tildes y espacios que uno de la lista coincide ⇒ deny ⇒ risk_denied (comercio)', async () => {
    stack.risk.sanctions.add('entidad sancionada de prueba');
    const merchant = 'mc_screen0000001';
    await seedMerchant(stack, merchant, 'active', QR_FEES, 'ENTIDAD   Sancionáda de Prueba');
    const response = await post(merchant);
    expect(response.body).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
    expect(callsFor(response.body.id as string)).toHaveLength(1); // denegó el comercio: no se llama por el pagador
    expect(stack.connectors.chargeFor(response.body.id as string)).toBeUndefined();
  });

  it('límite · el comercio pasa pero el PAGADOR coincide con la lista ⇒ risk_denied, sin cargo en el conector', async () => {
    stack.risk.sanctions.add(BLOCKED_NAME.toLowerCase());
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000, payerName: BLOCKED_NAME });
    await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 15_000, 'risk_denied del pagador');
    expect((await failureOf(id)).failure_code).toBe('risk_denied');
    expect(callsFor(id)).toHaveLength(2);
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });

  it('inválido · comercio SIN razón social en la réplica (no hay fuente contractual): NO se inventa un nombre; sale sin screening y pay-risk responde review ⇒ risk_denied (D-30)', async () => {
    const merchant = 'mc_screen0000002';
    await seedMerchant(stack, merchant, 'active', QR_FEES, null);
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, merchant)).toBeNull();
    const response = await post(merchant);
    expect(response.body).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
    const calls = callsFor(response.body.id as string);
    expect(calls).toHaveLength(1);
    expect(screeningOf(calls[0]!)).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).not.toContain(merchant.replace('mc_', 'name')); // ni el id ni nada derivado se manda como nombre
  });

  it('inválido · pay-risk caído ⇒ fail-closed como siempre (risk_unavailable), con y sin nombre de pagador', async () => {
    stack.risk.mode = 'down';
    const viaApi = (await post()).body;
    expect(viaApi).toMatchObject({ status: 'failed', last_error: { code: 'risk_unavailable' } });
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000, payerName: PAYER });
    await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 20_000, 'risk_unavailable con pagador');
    expect((await failureOf(id)).failure_code).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });

  it('inválido · review del cribado se trata como deny (D-30) también para el pagador', async () => {
    const id = nextId();
    stack.risk.requireScreening = false; // el comercio pasa
    await startDirectIntent(stack, { id, expiresInMs: 60_000, payerName: PAYER });
    expect(await chargeCreated(id)).toBeDefined();
    const second = nextId();
    stack.risk.mode = 'review';
    await startDirectIntent(stack, { id: second, expiresInMs: 60_000, payerName: PAYER });
    await waitFor(async () => ((await statusOf(stack, second)) === 'failed' ? true : undefined), 15_000, 'review ⇒ risk_denied');
    expect((await failureOf(second)).failure_code).toBe('risk_denied');
  });

  it('privacidad · el nombre del pagador no sale en la respuesta, ni en eventos del outbox, y se BORRA al llegar el intento a un estado terminal', async () => {
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 60_000, payerName: PAYER });
    await chargeCreated(id);
    expect((await stack.db.pool.query('SELECT payer_name FROM payment_intents WHERE id = $1', [id])).rows[0].payer_name).toBe(PAYER);
    const read = await http().get(`/payment_intents/${id}`).set(asMerchant(MC));
    expect(JSON.stringify(read.body)).not.toContain(PAYER);
    expect(JSON.stringify((await stack.db.pool.query('SELECT envelope FROM outbox_events WHERE aggregate_id = $1', [id])).rows)).not.toContain(PAYER);
    await stack.orchestrator.signalCharge(id, { status: 'failed', failureCode: 'card_declined' });
    await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 15_000, 'terminal');
    expect((await stack.db.pool.query('SELECT payer_name FROM payment_intents WHERE id = $1', [id])).rows[0].payer_name).toBeNull();
    expect(JSON.stringify((await stack.db.pool.query('SELECT envelope FROM outbox_events WHERE aggregate_id = $1', [id])).rows)).not.toContain(PAYER);
  });
});

describe('2 · la razón social llega a la réplica solo si el evento la trae (nunca se inventa)', () => {
  const handlers = () => new EventHandlers(stack.deps, stack.orchestrator);
  const event = (type: string, merchantId: string, time: Date, extra: Record<string, unknown> = {}) =>
    newCloudEvent({ id: randomUUID(), source: '/pay-merchants', type, subject: merchantId, merchantId, time, data: { merchant_id: merchantId, status: type === 'merchant.created' ? 'pending' : 'suspended', ...extra } });

  it('un evento con legal_name la guarda; uno posterior sin ella (suspended) NO la borra; un evento sin ella en un comercio nuevo deja NULL', async () => {
    const withName = 'mc_screen0000003';
    const t0 = Date.now() - 10_000;
    await handlers().merchantChanged(event('merchant.created', withName, new Date(t0), { created_at: new Date(t0).toISOString(), legal_name: '  Razon Social Sintetica S.A.  ' }));
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, withName)).toBe('Razon Social Sintetica S.A.');
    await handlers().merchantChanged(event('merchant.suspended', withName, new Date(t0 + 1000), { suspended_at: new Date(t0 + 1000).toISOString(), reason: 'risk_review' }));
    expect(await replicasRepo.merchantStatus(stack.deps.pool, withName)).toBe('suspended');
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, withName)).toBe('Razon Social Sintetica S.A.');
    const withoutName = 'mc_screen0000004';
    await handlers().merchantChanged(event('merchant.created', withoutName, new Date(t0), { created_at: new Date(t0).toISOString() }));
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, withoutName)).toBeNull();
  });

  it('inválido · un legal_name que no es texto (o está vacío) se ignora: no rompe el evento ni pone un valor', async () => {
    const id = 'mc_screen0000005';
    const t0 = Date.now() - 5000;
    for (const [i, bad] of [42, '   ', null, { name: 'x' }].entries()) {
      await handlers().merchantChanged(event('merchant.created', id, new Date(t0 + i), { created_at: new Date(t0).toISOString(), legal_name: bad }));
    }
    expect(await replicasRepo.merchantStatus(stack.deps.pool, id)).toBe('pending');
    expect(await replicasRepo.merchantLegalName(stack.deps.pool, id)).toBeNull();
  });
});

describe('3 · PAY_MODE explícito, sin valor por defecto', () => {
  const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const base = { ...(process.env as Record<string, string>), ...extra };
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete base[k];
    return base;
  };

  it('correcto · sandbox y live son los dos únicos valores', () => {
    expect(loadConfig(env({ PAY_MODE: 'sandbox' })).payMode).toBe('sandbox');
    expect(loadConfig(env({ PAY_MODE: 'live' })).payMode).toBe('live');
  });

  it('límite · sin PAY_MODE (o vacío) NO arranca, con un mensaje que dice qué hacer', () => {
    expect(() => loadConfig(env({ PAY_MODE: undefined }))).toThrow(/PAY_MODE debe ser «sandbox» o «live» y no tiene valor por defecto \(llegó: sin definir\)/);
    expect(() => loadConfig(env({ PAY_MODE: '' }))).toThrow(/sin definir/);
  });

  it.each(['Live', 'LIVE', 'production', 'test', ' live', 'sandbox '])('inválido · %j se rechaza (no se normaliza ni se interpreta)', (value) => {
    expect(() => loadConfig(env({ PAY_MODE: value }))).toThrow(/PAY_MODE debe ser «sandbox» o «live»/);
  });
});

describe('4 · bajo PAY_MODE=live el servicio se niega a arrancar con un doble o un conector mock/sandbox', () => {
  const live = () => assertNoDoublesInLive('live', stack.deps.clients.connectors);

  it('correcto · en sandbox no pregunta ni falla (aunque haya un mock); en live con todos los conectores reales arranca', async () => {
    stack.connectors.healthDown = true;
    await expect(assertNoDoublesInLive('sandbox', stack.deps.clients.connectors)).resolves.toBeUndefined();
    stack.connectors.healthDown = false;
    stack.connectors.health = [{ connector: 'bank_transfer', mode: 'live', status: 'up' }, { connector: 'mercantil_card', mode: 'live', status: 'degraded' }];
    await expect(live()).resolves.toBeUndefined();
  });

  it('límite · un solo conector mock, o uno en modo sandbox, entre varios reales ⇒ no arranca y el mensaje lo nombra', async () => {
    stack.connectors.health = [{ connector: 'bank_transfer', mode: 'live', status: 'up' }, { connector: 'mock', mode: 'live', status: 'up' }];
    await expect(live()).rejects.toThrow('PAY_MODE=live: pay-connectors tiene conectores de simulación o sandbox: mock (live); pay-payments se niega a arrancar');
    stack.connectors.health = [{ connector: 'bank_transfer', mode: 'live', status: 'up' }, { connector: 'mercantil_qr', mode: 'sandbox', status: 'up' }];
    await expect(live()).rejects.toThrow('mercantil_qr (sandbox)');
  });

  it('inválido · pay-connectors no contesta o no informa ningún conector ⇒ falla CERRADO (no se puede probar que no hay simulador)', async () => {
    stack.connectors.healthDown = true;
    await expect(live()).rejects.toThrow(/PAY_MODE=live: no se pudo verificar que pay-connectors no tiene conectores «mock» o «sandbox».*pay-payments se niega a arrancar/);
    stack.connectors.healthDown = false;
    stack.connectors.health = [];
    await expect(live()).rejects.toThrow('PAY_MODE=live: pay-connectors no informa ningún conector; pay-payments se niega a arrancar');
  });
});

describe('5 · apagado limpio: sin IllegalStateError «Not running» al recibir SIGTERM', () => {
  it('la API con el worker embebido (dist/main.js) se apaga solo y sin IllegalStateError al recibir SIGTERM', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/main.js')], {
      env: { ...stack.env, PORT: String(port), CONSUME_EVENTS: 'false', TEMPORAL_RUN_WORKER: 'true', TEMPORAL_TASK_QUEUE: `p3-shutdown-${randomUUID().slice(0, 8)}`, PGOPTIONS: `-c search_path=${stack.db.schema}`, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    // Nest apaga y vuelve a levantar la señal sobre sí mismo: terminar por SIGTERM (o con 0) es un apagado limpio; el defecto daba código 1.
    const exited = new Promise<string>((resolve) => child.once('exit', (code, signal) => resolve(code === 0 ? 'clean' : signal === 'SIGTERM' ? 'clean' : `code=${code} signal=${signal}`)));
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/live`).then((r) => r.ok).catch(() => false)) || undefined, 60_000, 'la API en pie');
      child.kill('SIGTERM');
      const code = await Promise.race([exited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000).unref())]);
      expect(code).toBe('clean');
      expect(output).not.toMatch(/IllegalStateError|Not running|Error happened during shutdown/);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL'); // por PID: nunca por nombre
    }
  });

  it('el worker en proceso (el de Nest) se puede apagar dos veces sin error: shutdown() es idempotente', async () => {
    const other = await startStack();
    await other.stop();
    await expect(other.worker?.shutdown()).resolves.toBeUndefined();
  });
});
