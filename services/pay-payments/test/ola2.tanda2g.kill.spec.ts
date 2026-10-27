import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect, type NatsConnection } from 'nats';
import { NatsEventPublisher, OutboxRelay, type EventPublisher } from '@pay/outbox';
import { refundsRepo } from '../src/persistence/refunds.repo';
import { startPaymentsWorker, type PaymentsWorker } from '../src/temporal/worker';
import { eventsOf, key, MC, seedMerchant, spawnWorker, startDirectIntent, startStack, statusOf, waitFor, WORKFLOWS_PATH, type ChildWorker, type Stack } from './helpers/stack';

/**
 * P3.H2.M8 · inyección de fallos, parte 2 (tanda 2g): matar el worker de Temporal (SIGKILL real, proceso aparte) en CADA actividad con la orden
 * «en vuelo» —el doble APLICA el efecto y retrasa la respuesta, que es el caso difícil: el efecto ocurrió y nadie lo confirmó— y comprobar
 * que el intento/reembolso termina en UN solo estado terminal, sin segundo cargo ni doble asiento. Además: duplicar y reordenar señales.
 * La tabla observada se escribe en `docs/trabajo/ola-2/P3/evidencia/2g-kill-worker.md`.
 */
let stack: Stack;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const alive: ChildWorker[] = [];
interface Row { n: number; actividad: string; inyeccion: string; observado: string }
const rows: Row[] = [];
let seq = 0;
const nextId = () => `pi_g4${String(Date.now()).slice(-7)}${String(seq++).padStart(3, '0')}`;
const row = (actividad: string, inyeccion: string, observado: string) => rows.push({ n: rows.length + 1, actividad, inyeccion, observado });

beforeAll(async () => {
  // El worker corre desde `dist/`: se compila el código actual (si no, la prueba ejercitaría una versión vieja).
  execFileSync(process.execPath, [path.join(process.cwd(), '../../node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: process.cwd(), stdio: 'pipe' });
  stack = await startStack({ inProcessWorker: false, env: { ACTIVITY_TIMEOUT_MS: '4000', ACTIVITY_MAX_ATTEMPTS: '8', STATUS_INQUIRY_MS: '60000', REFUND_WAIT_MS: '90000', CREATE_WAIT_MS: '90000' } });
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await Promise.all(alive.map((w) => w.kill()));
  const dir = path.join(process.cwd(), '../../docs/trabajo/ola-2/P3/evidencia');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '2g-kill-worker.md'),
    [
      '# Matar el worker en cada actividad (P3.H2.M8, tanda 2g)',
      '',
      'Generado por `services/pay-payments/test/ola2.tanda2g.kill.spec.ts` contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger ([DOBLE]). SIGKILL real de un worker en proceso aparte con la orden EN VUELO (el doble ya aplicó el efecto y todavía no respondió); un worker nuevo retoma la saga. Cada fila es lo OBSERVADO.',
      '',
      '| # | Actividad | Inyección | Observado |',
      '|---|---|---|---|',
      ...rows.map((r) => `| ${r.n} | ${r.actividad} | ${r.inyeccion} | ${r.observado} |`),
      '',
    ].join('\n'),
  );
  await stack.stop();
});
afterEach(async () => {
  await Promise.all(alive.splice(0).map((w) => w.kill())); // ningún worker de una prueba (aunque haya fallado) queda tomando tareas de la siguiente
  stack.risk.mode = 'allow';
  stack.connectors.scenario = 'ok';
  stack.connectors.server.routeDelays.length = 0;
  stack.ledger.server.routeDelays.length = 0;
  stack.ledger.latencyMs = 0;
});

const worker = async (): Promise<ChildWorker> => {
  const w = spawnWorker(stack);
  alive.push(w);
  await w.ready;
  return w;
};
const callSeen = (double: { server: { calls: { method: string; path: string; body: unknown }[] } }, method: string, pattern: RegExp, containing?: string) =>
  waitFor(async () => (double.server.calls.some((c) => c.method === method && pattern.test(c.path) && (!containing || JSON.stringify(c.body ?? '').includes(containing) || c.path.includes(containing))) ? true : undefined), 20_000, `${method} ${pattern} en vuelo`);
const settled = (id: string, status: string, timeout = 60_000) => waitFor(async () => ((await statusOf(stack, id)) === status ? true : undefined), timeout, `${id} → ${status}`);
const terminalEvents = async (id: string) => (await eventsOf(stack, id)).filter((e) => /^(payment_intent|refund)\.(succeeded|failed|canceled|expired)$/.test(e.type)).map((e) => e.type);
const capture = async (id: string) => {
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
};
const holdOf = (refundId: string) => [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refundId}:refund`);
const refundStatus = async (id: string) => (await refundsRepo.byId(stack.deps.pool, id))?.status;
const contradictionKinds = async (id: string) => (await stack.db.pool.query('SELECT kind, reason FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows as { kind: string; reason: string }[];

/** Un cobro exitoso con saldo para reembolsar, creado por un worker vivo. */
async function succeededIntent(): Promise<string> {
  const w = await worker();
  const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
  await capture(id);
  await settled(id, 'succeeded');
  stack.ledger.setBalance(`merchant:${MC}:available`, 20000);
  await w.kill();
  return id;
}

describe('SIGKILL del worker con la orden EN VUELO en cada actividad', () => {
  it('createCharge: el cargo ya se creó en el conector y el worker muere antes de saberlo ⇒ el worker nuevo NO crea un segundo cargo', async () => {
    const a = await worker();
    stack.connectors.server.routeDelays.push({ method: 'POST', pattern: /^\/charges$/, ms: 3500 });
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 300_000 });
    await callSeen(stack.connectors, 'POST', /^\/charges$/, id);
    await a.kill();
    stack.connectors.server.routeDelays.length = 0;
    expect(await statusOf(stack, id)).toBe('processing'); // la saga quedó a medias: el estado no se adelantó
    const b = await worker();
    await settled(id, 'requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    await capture(id);
    await settled(id, 'succeeded');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
    row('createCharge', 'SIGKILL con POST /charges aplicado y sin respuesta', `processing → requires_action → succeeded; cargos creados: ${stack.connectors.chargeCreations.get(id)}; asientos: ${stack.ledger.postedCount(`${id}:capture`)}; eventos terminales: 1`);
    await b.kill();
  });

  it('resolveExpiry: el cargo ya se canceló en el conector al vencer y el worker muere antes de saberlo ⇒ UN solo estado terminal (expired) y UN evento', async () => {
    const a = await worker();
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 7000 });
    await settled(id, 'requires_action');
    stack.connectors.server.routeDelays.push({ method: 'POST', pattern: /^\/charges\/ch_[a-z0-9]+\/cancel$/, ms: 3500 });
    await callSeen(stack.connectors, 'POST', /^\/charges\/ch_[a-z0-9]+\/cancel$/);
    await a.kill();
    stack.connectors.server.routeDelays.length = 0;
    expect(await statusOf(stack, id)).toBe('requires_action'); // vencido para el workflow pero sin cerrar
    const b = await worker();
    await settled(id, 'expired');
    expect(stack.connectors.chargeFor(id)?.status).toBe('canceled');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect(await terminalEvents(id)).toEqual(['payment_intent.expired']);
    row('resolveExpiry', 'SIGKILL con POST /charges/{id}/cancel aplicado y sin respuesta', `requires_action → expired (no canceled); cargos creados: 1; asientos: 0; eventos terminales: ${(await terminalEvents(id)).join(', ')}`);
    await b.kill();
  });

  it('holdRefund: la retención ya existe en el ledger y el worker muere antes de saberlo ⇒ UNA retención, UNA devolución, UN estado terminal', async () => {
    const intent = await succeededIntent();
    const a = await worker();
    stack.ledger.server.routeDelays.push({ method: 'POST', pattern: /^\/holds$/, ms: 3500 });
    const pending = stack.service.createRefund(MC, 'test', intent, key(), { amount_minor: 4000, reason: 'requested_by_customer' });
    await callSeen(stack.ledger, 'POST', /^\/holds$/);
    await a.kill();
    stack.ledger.server.routeDelays.length = 0;
    const b = await worker();
    const refundId = (await pending).body.id as string;
    await waitFor(async () => ((await refundStatus(refundId)) === 'succeeded' ? true : undefined), 60_000, 'reembolso completado');
    const holds = stack.ledger.server.callsTo('POST', /^\/holds$/).filter((c) => JSON.stringify(c.body).includes(`${refundId}:refund`));
    expect(new Set(holds.map((c) => c.headers['idempotency-key'] ?? JSON.stringify(c.body))).size).toBeGreaterThanOrEqual(1);
    expect([...stack.ledger.holds.values()].filter((h) => h.business_ref === `${refundId}:refund`)).toHaveLength(1);
    expect(holdOf(refundId)?.status).toBe('posted');
    expect([...stack.connectors.refunds.values()].filter((r) => r.refund_id === refundId)).toHaveLength(1);
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(16000);
    expect((await terminalEvents(refundId)).filter((t) => t.startsWith('refund.'))).toEqual(['refund.succeeded']);
    row('holdRefund', 'SIGKILL con POST /holds aplicado y sin respuesta', `reembolso succeeded; retenciones: 1 (posted); devoluciones en el conector: 1; saldo 20000 → 16000 (una sola vez); eventos terminales: refund.succeeded`);
    await b.kill();
  });

  it('finishRefund: el conector ya devolvió, la confirmación de la retención está aplicada y el worker muere antes de saberlo ⇒ la retención se confirma UNA vez y el saldo se debita UNA vez', async () => {
    const intent = await succeededIntent();
    const a = await worker();
    stack.ledger.server.routeDelays.push({ method: 'POST', pattern: /^\/holds\/hd_[a-z0-9]+\/post$/, ms: 3500 });
    const pending = stack.service.createRefund(MC, 'test', intent, key(), { amount_minor: 2500, reason: 'requested_by_customer' });
    await callSeen(stack.ledger, 'POST', /^\/holds\/hd_[a-z0-9]+\/post$/);
    await a.kill();
    stack.ledger.server.routeDelays.length = 0;
    const b = await worker();
    const refundId = (await pending).body.id as string;
    await waitFor(async () => ((await refundStatus(refundId)) === 'succeeded' ? true : undefined), 60_000, 'reembolso completado');
    expect(holdOf(refundId)?.status).toBe('posted');
    expect([...stack.connectors.refunds.values()].filter((r) => r.refund_id === refundId)).toHaveLength(1);
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(17500);
    expect(stack.ledger.server.callsTo('POST', /^\/holds\/hd_[a-z0-9]+\/void$/).filter((c) => c.path.includes(holdOf(refundId)!.id))).toHaveLength(0);
    expect((await terminalEvents(refundId)).filter((t) => t.startsWith('refund.'))).toEqual(['refund.succeeded']);
    row('finishRefund', 'SIGKILL con POST /holds/{id}/post aplicado y sin respuesta', `reembolso succeeded; retención posted (1 confirmación efectiva); 0 anulaciones; saldo 20000 → 17500 (una sola vez); eventos terminales: refund.succeeded`);
    await b.kill();
  });

  it('asiento del ledger (recordLedger): el asiento está aplicado y el worker muere antes de saberlo ⇒ UN asiento y UN evento terminal', async () => {
    const a = await worker();
    const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
    stack.ledger.server.routeDelays.push({ method: 'POST', pattern: /^\/transactions$/, ms: 3500 });
    await capture(id);
    await callSeen(stack.ledger, 'POST', /^\/transactions$/, `${id}:capture`);
    await a.kill();
    stack.ledger.server.routeDelays.length = 0;
    expect(await statusOf(stack, id)).toBe('processing');
    const b = await worker();
    await settled(id, 'succeeded');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
    row('recordLedger (asiento)', 'SIGKILL con POST /transactions aplicado y sin respuesta', `processing → succeeded; asientos: 1; eventos terminales: 1`);
    await b.kill();
  });
});

describe('«publicación»: el commit del estado terminal + su evento, y el relé del outbox', () => {
  let nats: NatsConnection;
  let inProcess: PaymentsWorker | undefined;
  const prefix = `p3k${randomBytes(4).toString('hex')}`;
  const STREAM = prefix.toUpperCase();

  beforeAll(async () => {
    nats = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:54222' });
    await (await nats.jetstreamManager()).streams.add({ name: STREAM, subjects: [`${prefix}.>`] });
  });
  afterAll(async () => {
    await inProcess?.shutdown();
    await (await nats.jetstreamManager()).streams.delete(STREAM).catch(() => undefined);
    await nats.drain();
  });

  it('completeIntent: el worker muere JUSTO DESPUÉS del commit (estado terminal y evento ya escritos) y antes de confirmar la actividad ⇒ la repetición no cambia nada: UN estado terminal, UN evento', async () => {
    // Crash simulado dentro del proceso (el commit de una sola sentencia no tiene ventana donde matar con SIGKILL): la actividad lanza DESPUÉS del
    // commit, Temporal la repite al menos una vez, igual que tras un SIGKILL. Lo declaro así en la tabla.
    const id = await (async () => {
      const w = await worker();
      const created = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
      await w.kill();
      return created;
    })();
    let crashed = 0;
    const flakyDeps = {
      ...stack.deps,
      tx: (async (fn: Parameters<typeof stack.deps.tx>[0]) => {
        const result = await stack.deps.tx(fn);
        const done = (await stack.db.pool.query("SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND type = 'payment_intent.succeeded'", [id])).rows.length > 0;
        if (done && crashed === 0) {
          crashed += 1;
          throw new Error('el worker murió después del commit');
        }
        return result;
      }) as typeof stack.deps.tx,
    };
    inProcess = await startPaymentsWorker(flakyDeps, { workflowsPath: WORKFLOWS_PATH });
    await capture(id);
    await settled(id, 'succeeded');
    await waitFor(async () => (crashed === 1 ? true : undefined), 20_000, 'el crash simulado ocurrió');
    await new Promise((resolve) => setTimeout(resolve, 1500)); // la actividad repetida termina
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
    row('completeIntent (commit + evento)', 'worker muere tras el commit, antes de confirmar la actividad (simulado en proceso)', `succeeded; asientos: 1; eventos terminales: 1; la actividad se repitió y no cambió nada`);
    await inProcess.shutdown();
    inProcess = undefined;
  });

  it('relé del outbox: publica y muere antes de marcar «publicado» ⇒ se republica con el MISMO id y JetStream lo descarta: UN mensaje en el bus', async () => {
    const id = await succeededIntent();
    const inner = new NatsEventPublisher(nats);
    let publishedThenCrashed = 0;
    const crashAfterPublish: EventPublisher = {
      publish: async (subject, event) => {
        await inner.publish(`${prefix}.${subject}`, event);
        if (event.subject === id && event.type === 'payment_intent.succeeded' && publishedThenCrashed === 0) {
          publishedThenCrashed += 1;
          throw new Error('el relé murió después de publicar');
        }
      },
    };
    const relay = new OutboxRelay(stack.servicePool, crashAfterPublish);
    await relay.drainOnce(); // publica y «muere» en el evento succeeded: no queda marcado
    expect(publishedThenCrashed).toBe(1);
    const pendingBefore = (await stack.db.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND type = 'payment_intent.succeeded' AND published_at IS NULL", [id])).rows[0].n;
    expect(pendingBefore).toBe(1);
    await relay.drainOnce(); // el relé nuevo lo reintenta
    const manager = await nats.jetstreamManager();
    const subject = `${prefix}.pay-payments.payment_intent.succeeded`;
    const info = await manager.streams.info(STREAM, { subjects_filter: `${prefix}.>` });
    let copies = 0;
    for (let s = 1; s <= info.state.last_seq; s++) {
      const m = await manager.streams.getMessage(STREAM, { seq: s }).catch(() => undefined);
      if (m?.subject === subject && m.json<{ subject: string }>().subject === id) copies += 1;
    }
    expect(copies).toBe(1);
    expect((await stack.db.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND type = 'payment_intent.succeeded' AND published_at IS NOT NULL", [id])).rows[0].n).toBe(1);
    row('publicación (relé del outbox)', 'el relé publica a NATS y muere antes de marcar published_at', `evento reintentado con el mismo id; mensajes en el bus: ${copies}; marcado publicado: sí`);
  });
});

describe('señales duplicadas y reordenadas (el workflow las recibe juntas, con el worker caído)', () => {
  /** Crea el cobro con un worker vivo, lo mata y deja las señales EN LA COLA de Temporal; el worker nuevo las recibe todas de golpe. */
  async function withQueuedSignals(signals: { status: 'authorized' | 'captured' | 'failed'; failureCode?: string }[], connectorStatus: 'succeeded' | 'failed' = 'succeeded'): Promise<string> {
    const a = await worker();
    const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
    await a.kill();
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, connectorStatus);
    for (const signal of signals) expect(await stack.orchestrator.signalCharge(id, signal)).toBe('delivered');
    await worker();
    return id;
  }

  it('captured ×3 + authorized atrasado + captured ⇒ succeeded, UN asiento, UN evento terminal y NINGUNA contradicción (son duplicados/obsoletos)', async () => {
    const id = await withQueuedSignals([{ status: 'captured' }, { status: 'captured' }, { status: 'authorized' }, { status: 'captured' }, { status: 'captured' }]);
    await settled(id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
    expect(await contradictionKinds(id)).toEqual([]);
    row('señales', 'captured ×4 y authorized atrasado, todos juntos', 'succeeded; asientos: 1; eventos terminales: 1; contradicciones: 0');
  });

  it('captured y DESPUÉS failed (misma ráfaga) ⇒ succeeded, UN asiento, y el `failed` contradictorio queda REGISTRADO y publicado (REQ-P3-3), no perdido', async () => {
    const id = await withQueuedSignals([{ status: 'captured' }, { status: 'failed', failureCode: 'card_declined' }]);
    await settled(id, 'succeeded');
    await waitFor(async () => ((await contradictionKinds(id)).length > 0 ? true : undefined), 20_000, 'contradicción registrada');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
    expect(await contradictionKinds(id)).toEqual([{ kind: 'status_conflict', reason: 'charge_captured_to_failed' }]);
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.contradiction_detected')).toHaveLength(1);
    row('señales', 'captured y luego failed en la misma ráfaga', 'succeeded; asientos: 1; eventos terminales: 1; contradicción registrada y publicada: 1');
  });

  it('failed y DESPUÉS captured (misma ráfaga, orden inverso) ⇒ failed, SIN asiento, y el dinero `captured` queda REGISTRADO como contradicción (el conector sí cobró)', async () => {
    const id = await withQueuedSignals([{ status: 'failed', failureCode: 'card_declined' }, { status: 'captured' }], 'failed');
    await settled(id, 'failed');
    await waitFor(async () => ((await contradictionKinds(id)).length > 0 ? true : undefined), 20_000, 'contradicción registrada');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect(await terminalEvents(id)).toEqual(['payment_intent.failed']);
    expect(await contradictionKinds(id)).toEqual([{ kind: 'status_conflict', reason: 'captured_for_failed_intent' }]);
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.contradiction_detected')).toHaveLength(1);
    row('señales', 'failed y luego captured en la misma ráfaga', 'failed; asientos: 0; eventos terminales: 1; contradicción registrada y publicada: 1');
  });

  it('señales de reembolso duplicadas y contradictorias (succeeded, succeeded, failed) con el conector en `pending` ⇒ UN estado terminal, UNA confirmación de la retención y el conflicto queda escalado', async () => {
    const intent = await succeededIntent();
    const a = await worker();
    stack.connectors.scenario = 'refund_pending';
    const pending = stack.service.createRefund(MC, 'test', intent, key(), { amount_minor: 1200, reason: 'requested_by_customer' });
    const refundId = await waitFor(async () => (await stack.db.pool.query('SELECT id FROM refunds WHERE payment_intent_id = $1 AND amount_minor = 1200', [intent])).rows[0]?.id as string | undefined, 20_000, 'reembolso creado');
    await waitFor(async () => (holdOf(refundId)?.status === 'pending' && stack.connectors.refunds.size > 0 ? true : undefined), 20_000, 'retención puesta y devolución pedida');
    await a.kill();
    stack.connectors.scenario = 'ok';
    for (const event of [{ status: 'succeeded' as const }, { status: 'succeeded' as const }, { status: 'failed' as const, failureCode: 'card_declined' }]) expect(await stack.orchestrator.signalRefund(refundId, event)).toBe('delivered');
    const b = await worker();
    await waitFor(async () => ((await refundStatus(refundId)) === 'succeeded' ? true : undefined), 60_000, 'reembolso completado');
    await pending.catch(() => undefined);
    expect(holdOf(refundId)?.status).toBe('posted');
    expect(stack.ledger.balance(`merchant:${MC}:available`)).toBe(18800);
    expect((await terminalEvents(refundId)).filter((t) => t.startsWith('refund.'))).toEqual(['refund.succeeded']);
    expect((await contradictionKinds(intent)).map((c) => c.kind)).toContain('refund_status_conflict');
    row('señales (reembolso)', 'succeeded, succeeded y failed contradictorio en la misma ráfaga', 'succeeded; retención confirmada 1 vez; saldo 20000 → 18800; eventos terminales: refund.succeeded; conflicto escalado (refund_status_conflict)');
    await b.kill();
  });

  it('disputa: resolver «lost» y «won» a la vez ⇒ gana la PRIMERA, UN débito del contracargo y UN evento', async () => {
    const intent = await succeededIntent();
    const a = await worker();
    const { dispute } = await stack.service.openDispute({ paymentIntentId: intent, openedKey: `prov-evt-g4-${randomBytes(3).toString('hex')}` });
    await a.kill();
    await stack.orchestrator.resolveDispute(dispute.id, 'lost');
    await stack.orchestrator.resolveDispute(dispute.id, 'won');
    const b = await worker();
    const { disputesRepo } = await import('../src/persistence/disputes.repo');
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'lost' ? true : undefined), 60_000, 'disputa perdida');
    expect(stack.ledger.postedCount(`${dispute.id}:chargeback`)).toBe(1);
    expect((await eventsOf(stack, dispute.id)).map((e) => e.type)).toEqual(['dispute.opened', 'dispute.lost']);
    row('señales (disputa)', 'resolve lost y resolve won en la misma ráfaga', 'lost (la primera); débitos del contracargo: 1; eventos: dispute.opened, dispute.lost');
    await b.kill();
  });
});
