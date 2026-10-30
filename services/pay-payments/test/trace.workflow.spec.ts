import { randomBytes } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { intentsRepo } from '../src/persistence/intents.repo';
import { runWithRequestId } from '../src/observability/trace-propagation';
import { danglingParents, exported, idOf, inServerSpan, parentIdOf, spansNamed, startTestTracing, type Finished } from './helpers/otel';
import { key, MC, seedMerchant, startStack, waitFor, type Stack } from './helpers/stack';

/**
 * P1.H2.M3 (T3): el cobro corre en un workflow de Temporal, fuera de la petición. El contexto (traceparent + x-request-id) viaja como dato del input del workflow y
 * cada activity que llama hacia afuera lo reconstruye. Acá, con Temporal, Postgres y los dobles de riesgo, conector y ledger REALES (los dobles validan sus contratos):
 *  · CORRECTO: la llamada a riesgo, la del conector y la del ledger cuelgan de `server → start PaymentWorkflow → activity → POST …`, en UNA traza y sin padres ausentes,
 *    y llevan el x-request-id de la petición de origen.
 *  · LÍMITE: sin traza ni id de origen el cobro avanza igual (traza nueva por activity, id propio) y el input del workflow queda exactamente como antes del campo.
 *  · INVÁLIDO: un workflow arrancado con un carrier basura sigue su camino sin lanzar.
 * La instrumentación http real y Jaeger se prueban en e2e/flows/traza-jaeger-arbol.e2e.ts.
 */
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let stack: Stack;
let temporal: { client: Client; connection: Connection };

beforeAll(async () => {
  startTestTracing();
  stack = await startStack();
  await seedMerchant(stack, MC);
  const connection = await Connection.connect({ address: stack.config.temporal.address });
  temporal = { connection, client: new Client({ connection, namespace: stack.config.temporal.namespace }) };
});
afterAll(async () => {
  await temporal.connection.close();
  await stack.stop();
});
beforeEach(() => {
  exported.reset();
  stack.risk.reset();
  stack.connectors.scenario = 'ok';
});

const intentOf = (call: { body: unknown }): string | undefined => (call.body as { payment_intent_id?: string }).payment_intent_id;
const riskCallOf = (id: string) => stack.risk.server.calls.find((c) => intentOf(c) === id)!;
const chargeCallOf = (id: string) => stack.connectors.server.calls.find((c) => c.method === 'POST' && c.path === '/charges' && intentOf(c) === id)!;
const ledgerCallOf = (id: string) => stack.ledger.server.calls.find((c) => c.method === 'POST' && c.path === '/transactions' && (c.body as { business_ref?: string }).business_ref === `${id}:capture`)!;
const spanOfCall = (call: { headers: Record<string, string | string[] | undefined> }): Finished => {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(call.headers.traceparent as string);
  expect(m).not.toBeNull();
  const span = exported.getFinishedSpans().find((s) => idOf(s) === m![2]);
  expect(span).toBeDefined();
  expect(span!.spanContext().traceId).toBe(m![1]);
  return span!;
};
const parentOf = (span: Finished): Finished => {
  const parent = exported.getFinishedSpans().find((s) => idOf(s) === parentIdOf(span));
  expect(parent).toBeDefined();
  return parent!;
};
const startedInput = async (id: string): Promise<Record<string, unknown>> => {
  const history = await temporal.client.workflow.getHandle(`payment-${id}`).fetchHistory();
  const started = history.events?.find((e) => e.workflowExecutionStartedEventAttributes);
  const payload = started!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!;
  return JSON.parse(Buffer.from(payload.data!).toString('utf8')) as Record<string, unknown>;
};

describe('CORRECTO — petición con traza y x-request-id → riesgo, conector y ledger', () => {
  it('server → start PaymentWorkflow → activity → POST pay-risk / pay-connectors / pay-ledger: una traza, sin padres ausentes, con el id de la petición en las tres llamadas', async () => {
    const requestId = `traza-wf-${hex(5)}`;
    const entering = `00-${hex(16)}-${hex(8)}-01`;
    const {
      result: created,
      traceId,
      spanId,
    } = await inServerSpan(entering, () => runWithRequestId(requestId, () => stack.service.createIntent(MC, 'test', key(), QR)));
    expect(created.status).toBe(201);
    expect(traceId).toBe(entering.split('-')[1]);
    const id = created.body.id as string;

    const risk = riskCallOf(id);
    const riskHttp = spanOfCall(risk);
    const riskActivity = parentOf(riskHttp);
    const start = parentOf(riskActivity);
    expect([riskHttp.name, riskActivity.name, start.name]).toEqual(['POST pay-risk', 'activity assessRisk', 'start PaymentWorkflow']);
    expect(parentIdOf(start)).toBe(spanId);

    const charge = chargeCallOf(id);
    const chargeHttp = spanOfCall(charge);
    expect([chargeHttp.name, parentOf(chargeHttp).name]).toEqual(['POST pay-connectors', 'activity createCharge']);
    expect(idOf(parentOf(parentOf(chargeHttp)))).toBe(idOf(start));

    expect(risk.headers['x-request-id']).toBe(requestId);
    expect(charge.headers['x-request-id']).toBe(requestId);

    // El pago llega por el conector: el asiento en el ledger también cuelga de la misma traza y lleva el mismo id.
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await waitFor(async () => ((await intentsRepo.byId(stack.deps.pool, id))?.status === 'succeeded' ? true : undefined), 30_000, 'cobro succeeded');
    const ledgerCall = ledgerCallOf(id);
    const ledgerHttp = spanOfCall(ledgerCall);
    expect([ledgerHttp.name, parentOf(ledgerHttp).name]).toEqual(['POST pay-ledger', 'activity recordLedger']);
    expect(ledgerCall.headers['x-request-id']).toBe(requestId);

    const ofThisTrace = exported.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
    expect(new Set(exported.getFinishedSpans().map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));
    expect(ofThisTrace.length).toBe(exported.getFinishedSpans().length);
    // El span servidor simulado cuelga del traceparent entrante (un span del cliente que no se exporta aquí): es la única raíz «huérfana» permitida.
    expect(danglingParents().map((s) => s.name)).toEqual(['SERVER (doble de HttpInstrumentation)']);
    for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
  });

  it('el input del workflow lleva `trace` con el traceparent y el id; ninguna otra cosa cambia (idempotencia, claves de riesgo y de cargo)', async () => {
    const requestId = `traza-wf-${hex(5)}`;
    const { result: created } = await inServerSpan(undefined, () => runWithRequestId(requestId, () => stack.service.createIntent(MC, 'test', key(), QR)));
    const id = created.body.id as string;
    const input = await startedInput(id);
    expect(Object.keys(input).sort()).toEqual(['intentId', 'trace']);
    expect(input.trace).toMatchObject({ requestId, traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/) });
    const risk = stack.risk.server.calls.filter((c) => intentOf(c) === id);
    expect([...new Set(risk.map((c) => c.headers['idempotency-key']))]).toEqual([`${id}:risk`]);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
  });
});

describe('LÍMITE — sin contexto de origen, o con el cobro ya en marcha', () => {
  it('sin petición de origen (ni span ni id): el input lleva solo el traceparent del span `start` (traza nueva real), sin id; cada llamada genera su propio UUID', async () => {
    const created = await stack.service.createIntent(MC, 'test', key(), QR); // sin server span ni alcance de id
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const input = await startedInput(id);
    expect(Object.keys(input).sort()).toEqual(['intentId', 'trace']);
    expect(Object.keys(input.trace as object)).toEqual(['traceparent']);
    const risk = riskCallOf(id);
    expect(risk.headers['x-request-id']).toMatch(UUID);
    const activity = parentOf(spanOfCall(risk));
    expect(activity.name).toBe('activity assessRisk');
    expect(parentOf(activity).name).toBe('start PaymentWorkflow');
    expect(parentIdOf(parentOf(activity))).toBeUndefined(); // raíz de una traza nueva
  });

  it('un workflow con el input de ANTES del campo ({intentId}, como los que estaban en vuelo) sigue su camino: el cobro llega a requires_action con UNA evaluación y UN cargo', async () => {
    const id = `pi_legacy${hex(6)}`;
    await stack.deps.tx(async (db) => {
      await intentsRepo.insert(db, { id, merchantId: MC, mode: 'test', amountMinor: 10000, method: 'qr', feeMinor: 300, netMinor: 9700, metadata: {}, expiresAt: new Date(Date.now() + 120_000) });
    });
    await temporal.client.workflow.start('PaymentWorkflow', { args: [{ intentId: id }], taskQueue: stack.config.temporal.taskQueue, workflowId: `payment-${id}` });
    await waitFor(async () => ((await intentsRepo.byId(stack.deps.pool, id))?.status === 'requires_action' ? true : undefined), 30_000, 'cobro heredado → requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(stack.risk.server.calls.filter((c) => intentOf(c) === id)).toHaveLength(1);
    const risk = riskCallOf(id);
    expect(risk.headers['x-request-id']).toMatch(UUID);
    expect(risk.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const activity = parentOf(spanOfCall(risk));
    expect([activity.name, parentIdOf(activity)]).toEqual(['activity assessRisk', undefined]);
  });

  it('un traceparent entrante NO muestreado (flags 00) llega a riesgo y conector con flags 00 y no se exporta ningún span del cobro', async () => {
    const tid = hex(16);
    const { result: created } = await inServerSpan(`00-${tid}-${hex(8)}-00`, () => runWithRequestId('traza-sin-muestreo-1', () => stack.service.createIntent(MC, 'test', key(), QR)));
    const id = created.body.id as string;
    const risk = riskCallOf(id);
    const charge = chargeCallOf(id);
    for (const call of [risk, charge]) expect(call.headers.traceparent).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
    expect(risk.headers['x-request-id']).toBe('traza-sin-muestreo-1');
    expect(exported.getFinishedSpans()).toHaveLength(0);
  });

  it('un x-request-id de 65 caracteres (inválido) no se propaga: las llamadas generan el suyo y el cobro avanza', async () => {
    const { result: created } = await inServerSpan(undefined, () => runWithRequestId('a'.repeat(65), () => stack.service.createIntent(MC, 'test', key(), QR)));
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const risk = riskCallOf(id);
    expect(risk.headers['x-request-id']).toMatch(UUID);
    expect((await startedInput(id)).trace).toMatchObject({ traceparent: expect.any(String) });
    expect(((await startedInput(id)).trace as Record<string, unknown>).requestId).toBeUndefined();
  });
});

describe('INVÁLIDO — carrier basura en un workflow ya existente', () => {
  it('un workflow arrancado con un `trace` malformado (traceparent y id inválidos, campos de más) completa su primer tramo igual: no lanza ni cambia el resultado del cobro', async () => {
    const created = await stack.service.createIntent(MC, 'test', key(), QR);
    const base = created.body.id as string;
    // Otro intento con el MISMO contenido pero arrancado a mano con un carrier roto (como si el input lo hubiera escrito algo ajeno).
    const id = `pi_garbage${hex(6)}`;
    await stack.deps.tx(async (db) => {
      await intentsRepo.insert(db, { id, merchantId: MC, mode: 'test', amountMinor: 10000, method: 'qr', feeMinor: 300, netMinor: 9700, metadata: {}, expiresAt: new Date(Date.now() + 120_000) });
    });
    await temporal.client.workflow.start('PaymentWorkflow', {
      args: [{ intentId: id, trace: { traceparent: 'basura-'.repeat(200), requestId: 'con espacios <x>', extra: { a: 1 } } }],
      taskQueue: stack.config.temporal.taskQueue,
      workflowId: `payment-${id}`,
    });
    const row = await waitFor(async () => {
      const r = await intentsRepo.byId(stack.deps.pool, id);
      return r?.status === 'requires_action' ? r : undefined;
    }, 30_000, 'cobro con carrier basura → requires_action');
    expect(row.status).toBe('requires_action');
    const risk = riskCallOf(id);
    expect(risk.headers['x-request-id']).toMatch(UUID);
    expect(risk.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(base).not.toBe(id);
    expect(spansNamed('activity assessRisk').some((s) => parentIdOf(s) === undefined)).toBe(true);
  });
});
