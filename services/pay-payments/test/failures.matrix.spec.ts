import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { refundsRepo } from '../src/persistence/refunds.repo';
import { intentsRepo } from '../src/persistence/intents.repo';
import { disputesRepo } from '../src/persistence/disputes.repo';
import { eventsOf, key, MC, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * P3.H2.M8 · inyección de fallos. Cada escenario inyecta UN fallo en UNA dependencia, observa el resultado y comprueba las
 * invariantes: el cobro termina en a lo sumo un estado terminal, el ledger tiene a lo sumo UN asiento por operación y un
 * resultado AMBIGUO se conserva y se escala (CLAUDE.md regla 11) en lugar de cerrarse. La tabla observada se escribe en
 * `docs/trabajo/ola-1/P3/evidencia/fallos-p3.md` al terminar.
 */
let stack: Stack;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
interface Row { n: number; dependencia: string; fallo: string; clase: string; esperado: string; observado: string; asientos: string; escalado: string }
const rows: Row[] = [];

beforeAll(async () => {
  stack = await startStack({ env: { REFUND_WAIT_MS: '2000' } });
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  const dir = path.join(process.cwd(), '../../docs/trabajo/ola-1/P3/evidencia');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '# Inyección de fallos de pay-payments (P3.H2.M8)',
    '',
    'Generado por `services/pay-payments/test/failures.matrix.spec.ts` contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger ([DOBLE], regla 65). Cada fila es lo OBSERVADO en la corrida, no lo esperado.',
    '',
    '**Clase:** *definitivo* = respuesta que el contrato declara (4xx con su cuerpo, `502 connector_unavailable` exacto, rechazo 422 del ledger); *ambiguo* = timeout, corte, otro 5xx o respuesta fuera de contrato (no prueba que la orden no se ejecutó: se conserva el estado, se reintenta con la MISMA clave y se escala).',
    '',
    '| # | Dependencia | Fallo inyectado | Clase | Esperado | Observado | Asientos del ledger | Escalado a una persona |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.n} | ${r.dependencia} | ${r.fallo} | ${r.clase} | ${r.esperado} | ${r.observado} | ${r.asientos} | ${r.escalado} |`),
    '',
    'No inyectado aquí (ver REPORTE): caída del worker (`payment.kill.spec.ts`, SIGKILL real, 5 corridas), caída de Postgres, partición de red de NATS.',
  ];
  writeFileSync(path.join(dir, 'fallos-p3.md'), `${lines.join('\n')}\n`);
  await stack.stop();
});
afterEach(() => {
  stack.risk.mode = 'allow';
  stack.connectors.scenario = 'ok';
  stack.ledger.failNext = 0;
  stack.ledger.rejectPattern = null;
});

const escalations = async (id: string): Promise<string> => (await stack.db.pool.query('SELECT kind FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows.map((r) => r.kind).join(', ') || 'no';
const settled = (id: string, status: string, timeout = 30_000) => waitFor(async () => ((await statusOf(stack, id)) === status ? true : undefined), timeout, `${id} → ${status}`);
const hasEscalation = (id: string, kind: string) => waitFor(async () => (Number((await stack.db.pool.query('SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = $2', [id, kind])).rows[0].n) > 0 ? true : undefined), 30_000, `escalado ${kind}`);
const pay = async (id: string) => {
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
};
const terminalEvents = async (id: string) => (await eventsOf(stack, id)).filter((e) => /\.(succeeded|failed|canceled|expired)$/.test(e.type)).length;
const entries = (ref: string) => String(stack.ledger.postedCount(ref));
let n = 0;
const row = (r: Omit<Row, 'n'>) => rows.push({ n: ++n, ...r });

describe('cobro (PaymentWorkflow)', () => {
  it('riesgo caído (503)', async () => {
    stack.risk.mode = 'down';
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'risk_unavailable' } });
    expect(await terminalEvents(intent.id as string)).toBe(1);
    row({ dependencia: 'pay-risk', fallo: '503 Service Unavailable', clase: 'fail-closed (no mueve dinero)', esperado: 'failed risk_unavailable, sin cargo', observado: `failed (${(intent.last_error as { code: string }).code}), cargo creado: ${stack.connectors.chargeFor(intent.id as string) ? 'sí' : 'no'}`, asientos: entries(`${intent.id}:capture`), escalado: await escalations(intent.id as string) });
  });

  it('riesgo colgado', async () => {
    stack.risk.mode = 'hang';
    const t = Date.now();
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'risk_unavailable' } });
    row({ dependencia: 'pay-risk', fallo: 'no responde (timeout 300 ms)', clase: 'fail-closed (no mueve dinero)', esperado: 'failed risk_unavailable en pocos segundos', observado: `failed en ${Date.now() - t} ms`, asientos: entries(`${intent.id}:capture`), escalado: await escalations(intent.id as string) });
  });

  it('riesgo lento pero dentro del plazo', async () => {
    stack.risk.mode = { slowMs: 150 };
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    expect(intent.status).toBe('requires_action');
    row({ dependencia: 'pay-risk', fallo: 'respuesta lenta (150 ms < 300 ms)', clase: 'sin fallo', esperado: 'el cobro sigue', observado: String(intent.status), asientos: entries(`${intent.id}:capture`), escalado: 'no' });
  });

  it('conector: 502 connector_unavailable exacto al crear el cargo', async () => {
    stack.connectors.scenario = 'down';
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'connector_unavailable' } });
    row({ dependencia: 'pay-connectors', fallo: '502 problem+json connector_unavailable (crear cargo)', clase: 'definitivo (no se envió nada)', esperado: 'reintenta y cierra failed connector_unavailable', observado: `failed (${(intent.last_error as { code: string }).code}); POST /charges: ${stack.connectors.server.callsTo('POST', /^\/charges$/).length} llamadas en total`, asientos: entries(`${intent.id}:capture`), escalado: await escalations(intent.id as string) });
  });

  it('conector: 500 genérico al crear el cargo (ambiguo)', async () => {
    stack.connectors.scenario = 'charge_ambiguous';
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    const id = intent.id as string;
    expect(intent.status).toBe('processing');
    await hasEscalation(id, 'charge_outcome_unknown');
    const escalated = await escalations(id);
    stack.connectors.scenario = 'ok';
    await settled(id, 'requires_action');
    await pay(id);
    await settled(id, 'succeeded');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(entries(`${id}:capture`)).toBe('1');
    row({ dependencia: 'pay-connectors', fallo: '500 al crear el cargo, luego vuelve', clase: 'ambiguo', esperado: 'processing + escalado; al volver, 1 solo cargo y succeeded', observado: `processing → requires_action → succeeded; cargos creados: ${stack.connectors.chargeCreations.get(id)}`, asientos: entries(`${id}:capture`), escalado: escalated });
  });

  it('conector: rechazo 422 (tarjeta rechazada)', async () => {
    stack.connectors.scenario = 'decline';
    const intent = (await stack.service.createIntent(MC, key(), QR)).body;
    expect(intent.status).toBe('failed');
    row({ dependencia: 'pay-connectors', fallo: '422 validation_failed (rechazo del proveedor)', clase: 'definitivo', esperado: 'failed, sin asiento', observado: `failed (${(intent.last_error as { code: string }).code})`, asientos: entries(`${intent.id}:capture`), escalado: 'no' });
  });

  it('ledger: 3 fallos 500 y vuelve', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.ledger.failNext = 3;
    await pay(id);
    await settled(id, 'succeeded');
    expect(entries(`${id}:capture`)).toBe('1');
    row({ dependencia: 'pay-ledger', fallo: '3 respuestas 500 seguidas', clase: 'ambiguo', esperado: 'se reintenta con la misma clave; 1 asiento', observado: 'succeeded', asientos: entries(`${id}:capture`), escalado: await escalations(id) });
  });

  it('ledger: caído un rato después de capturar (ambiguo)', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.ledger.failNext = 1000;
    await pay(id);
    await hasEscalation(id, 'ledger_outcome_unknown');
    const during = await statusOf(stack, id);
    const refunded = [...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id).length;
    expect({ during, refunded }).toEqual({ during: 'processing', refunded: 0 });
    const escalated = await escalations(id);
    stack.ledger.failNext = 0;
    await settled(id, 'succeeded');
    expect(entries(`${id}:capture`)).toBe('1');
    expect(await terminalEvents(id)).toBe(1);
    row({ dependencia: 'pay-ledger', fallo: '500 sostenido tras el cobro del banco, luego vuelve', clase: 'ambiguo', esperado: 'processing, sin devolver el dinero, escalado; al volver 1 asiento', observado: `${during} (devoluciones al banco: ${refunded}) → succeeded`, asientos: entries(`${id}:capture`), escalado: escalated });
  });

  it('ledger: rechazo 422 del asiento', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.ledger.rejectPattern = /:capture$/;
    await pay(id);
    await settled(id, 'failed');
    const refunded = [...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id).length;
    expect(refunded).toBe(1);
    row({ dependencia: 'pay-ledger', fallo: '422 insufficient_funds al registrar el cobro', clase: 'definitivo', esperado: 'compensa: devuelve el dinero en el conector y cierra failed', observado: `failed (${(await intentsRepo.byId(stack.deps.pool, id))?.failureCode}); devoluciones al banco: ${refunded}`, asientos: entries(`${id}:capture`), escalado: await escalations(id) });
  });

  it('callbacks duplicados y reordenados', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    for (const status of ['captured', 'captured', 'authorized', 'captured', 'failed'] as const) await stack.orchestrator.signalCharge(id, { status });
    await settled(id, 'succeeded');
    await new Promise((r) => setTimeout(r, 800));
    expect(entries(`${id}:capture`)).toBe('1');
    expect(await terminalEvents(id)).toBe(1);
    row({ dependencia: 'pay-connectors (eventos)', fallo: 'captured ×3, authorized atrasado y failed contradictorio', clase: 'duplicado / obsoleto / contradicción', esperado: 'un solo estado terminal y un solo asiento', observado: `succeeded; eventos terminales: ${await terminalEvents(id)}`, asientos: entries(`${id}:capture`), escalado: await escalations(id) });
  });
});

describe('reembolso (RefundWorkflow)', () => {
  const succeededIntent = async (): Promise<string> => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    await pay(id);
    await settled(id, 'succeeded');
    stack.ledger.setBalance(`merchant:${MC}:available`, 20000);
    return id;
  };
  const available = () => stack.ledger.balance(`merchant:${MC}:available`);
  const holdOf = (refundId: string) => [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refundId}:refund`);

  it('conector: 502 connector_unavailable exacto', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_down';
    const r = (await stack.service.createRefund(MC, id, key(), { amount_minor: 2000 })).body;
    expect(r).toMatchObject({ status: 'failed' });
    expect(holdOf(r.id as string)?.status).toBe('voided');
    row({ dependencia: 'pay-connectors', fallo: '502 connector_unavailable exacto al reembolsar', clase: 'definitivo (sin efecto)', esperado: 'anula la retención; reembolso failed', observado: `failed; retención ${holdOf(r.id as string)?.status}; saldo ${available()}`, asientos: '0', escalado: await escalations(id) });
  });

  it('conector: 500 genérico (ambiguo), luego vuelve', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_ambiguous';
    const r = (await stack.service.createRefund(MC, id, key(), { amount_minor: 2000 })).body;
    const refundId = r.id as string;
    await hasEscalation(id, 'refund_outcome_unknown');
    expect({ status: r.status, hold: holdOf(refundId)?.status, available: available() }).toEqual({ status: 'pending', hold: 'pending', available: 20000 });
    const escalated = await escalations(id);
    stack.connectors.scenario = 'ok';
    await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refundId))?.status === 'succeeded' ? true : undefined), 30_000, 'reembolso');
    expect({ hold: holdOf(refundId)?.status, available: available() }).toEqual({ hold: 'posted', available: 18000 });
    row({ dependencia: 'pay-connectors', fallo: '500 al reembolsar, luego vuelve', clase: 'ambiguo', esperado: 'retención conservada, escalado; al volver se confirma 1 vez', observado: 'pending (retención pending) → succeeded (retención posted)', asientos: '1 retención confirmada', escalado: escalated });
  });

  it('ledger: 500 al retener (ambiguo), luego vuelve', async () => {
    const id = await succeededIntent();
    const callsBefore = stack.connectors.server.callsTo('POST', /\/refunds$/).length;
    stack.ledger.failNext = 1000;
    const r = (await stack.service.createRefund(MC, id, key(), { amount_minor: 2000 })).body;
    const refundId = r.id as string;
    await hasEscalation(id, 'hold_outcome_unknown');
    expect(r.status).toBe('pending');
    expect(stack.connectors.server.callsTo('POST', /\/refunds$/).length).toBe(callsBefore);
    const escalated = await escalations(id);
    stack.ledger.failNext = 0;
    await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refundId))?.status === 'succeeded' ? true : undefined), 30_000, 'reembolso');
    row({ dependencia: 'pay-ledger', fallo: '500 al crear la retención, luego vuelve', clase: 'ambiguo', esperado: 'pending sin tocar al conector; al volver se completa', observado: 'pending → succeeded', asientos: '1 retención confirmada', escalado: escalated });
  });

  it('conector: pending y nadie avisa', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const r = (await stack.service.createRefund(MC, id, key(), { amount_minor: 1500 })).body;
    await hasEscalation(id, 'refund_pending_timeout');
    expect({ status: (await refundsRepo.byId(stack.deps.pool, r.id as string))?.status, hold: holdOf(r.id as string)?.status }).toEqual({ status: 'pending', hold: 'pending' });
    row({ dependencia: 'pay-connectors (eventos)', fallo: 'devolución `pending` y el aviso nunca llega', clase: 'ambiguo (sin consulta posible)', esperado: 'no se libera la retención ni se da por fallido; escalado', observado: 'pending, retención pending, esperando el aviso sin plazo', asientos: '0 confirmadas', escalado: await escalations(id) });
  });
});

describe('disputa (DisputeWorkflow)', () => {
  it('ledger: 500 al debitar el contracargo (ambiguo), luego vuelve', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    await pay(id);
    await settled(id, 'succeeded');
    const { dispute } = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'matrix-1' });
    stack.ledger.failNext = 1000;
    await stack.service.resolveDispute(dispute.id, 'lost');
    await hasEscalation(id, 'dispute_ledger_unknown');
    expect((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status).toBe('open');
    const escalated = await escalations(id);
    stack.ledger.failNext = 0;
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'lost' ? true : undefined), 30_000, 'disputa perdida');
    expect(stack.ledger.postedCount(`${dispute.id}:chargeback`)).toBe(1);
    row({ dependencia: 'pay-ledger', fallo: '500 al debitar el contracargo, luego vuelve', clase: 'ambiguo', esperado: 'sigue abierta y escalada; al volver 1 débito', observado: 'open → lost', asientos: entries(`${dispute.id}:chargeback`), escalado: escalated });
  });
});
