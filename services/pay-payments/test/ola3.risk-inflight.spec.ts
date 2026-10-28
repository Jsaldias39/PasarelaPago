import { Client, Connection } from '@temporalio/client';
import { eventsOf, key, MC, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * Tanda 3e · un resultado AMBIGUO del riesgo no es un rechazo (CLAUDE.md regla 11). Defecto hallado por el arnés E2E de P1
 * (`e2e/pending/risk-timeout.e2e.ts`): `pay-payments` vence en 300 ms, reintenta con la MISMA clave y recibe
 * `409 idempotency_request_in_progress` porque la primera evaluación sigue en vuelo en pay-risk; `assessRisk` lo trataba como rechazo
 * definitivo (`nonRetryable`) y el workflow moría con el intento en `processing` para siempre.
 * Ahora: un 409 «en curso» o un timeout se reintentan con la misma clave (Temporal, con espera creciente) hasta que riesgo responda; si se agota la
 * política, el intento termina `failed/risk_unavailable` (fail-closed, sin cargo) y deja constancia; un 4xx que no es una decisión también cierra
 * fail-closed (y deja constancia) en vez de matar el workflow. Solo `deny`/`review` en una respuesta válida son «no».
 * Se prueba con el doble de riesgo, que valida `internal-risk-v1`, en tres niveles (regla 65).
 */
let stack: Stack;
let temporal: { client: Client; connection: Connection };
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const ATTEMPTS = 4; // ACTIVITY_MAX_ATTEMPTS del stack de pruebas

beforeAll(async () => {
  stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS) } });
  await seedMerchant(stack, MC);
  const connection = await Connection.connect({ address: stack.config.temporal.address });
  temporal = { connection, client: new Client({ connection, namespace: stack.config.temporal.namespace }) };
});
afterAll(async () => {
  await temporal.connection.close();
  await stack.stop();
});
afterEach(() => {
  stack.risk.reset();
  stack.connectors.scenario = 'ok';
});

const create = async (): Promise<string> => (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
const settledAs = (id: string, ...statuses: string[]) => waitFor(async () => ((await statusOf(stack, id)) && statuses.includes((await statusOf(stack, id)) as string) ? ((await statusOf(stack, id)) as string) : undefined), 60_000, `${id} → ${statuses.join('|')}`);
const riskCalls = (id: string) => stack.risk.server.calls.filter((c) => (c.body as { payment_intent_id?: string }).payment_intent_id === id);
/** Estado del workflow en Temporal (`COMPLETED`, `RUNNING`, `FAILED`…): un intento terminal con el workflow muerto o colgado sería otra forma de «processing eterno». */
const workflowStatus = async (id: string): Promise<string> => (await temporal.client.workflow.getHandle(`payment-${id}`).describe()).status.name;
const terminalEvents = async (id: string) => (await eventsOf(stack, id)).filter((e) => /^payment_intent\.(succeeded|failed|canceled|expired)$/.test(e.type)).map((e) => e.type);
const escalations = async (id: string) => (await stack.db.pool.query('SELECT kind FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows.map((r: { kind: string }) => r.kind);

describe('correcto · la evaluación de riesgo está EN VUELO: se reintenta con la misma clave y el cobro avanza UNA vez', () => {
  it('la primera evaluación tarda más que el timeout del cliente: el reintento recibe 409 «en curso», se espera y luego se repite la respuesta guardada ⇒ requires_action, UN cargo, UNA clave', async () => {
    stack.risk.mode = { firstSlowMs: 900 };
    const id = await create();
    await settledAs(id, 'requires_action');
    const calls = riskCalls(id);
    expect(calls.length).toBeGreaterThanOrEqual(3); // timeout, 409 en curso y la respuesta guardada
    expect([...new Set(calls.map((c) => c.headers['idempotency-key']))]).toEqual([`${id}:risk`]);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(await escalations(id)).toEqual([]);
  });

  it('409 «en curso» dos veces y luego la decisión `allow` ⇒ el intento avanza y cobra UNA vez', async () => {
    stack.risk.mode = { inProgressFirst: 2 };
    const id = await create();
    await settledAs(id, 'requires_action');
    expect(riskCalls(id)).toHaveLength(3);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await settledAs(id, 'succeeded');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(await terminalEvents(id)).toEqual(['payment_intent.succeeded']);
  });

  it('timeout del cliente y luego `allow` ⇒ el intento avanza (un timeout no es un rechazo)', async () => {
    stack.risk.mode = { hangFirst: 3 };
    const id = await create();
    await settledAs(id, 'requires_action');
    expect(riskCalls(id).length).toBeGreaterThanOrEqual(4);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
  });
});

describe('límite · la decisión nunca llega: terminal VISIBLE (failed/risk_unavailable), fail-closed, sin cargo; nunca `processing` eterno', () => {
  it('409 «en curso» persistente ⇒ se agotan los intentos de la política (misma clave), el intento queda failed/risk_unavailable, sin cargo ni asiento, con constancia para una persona', async () => {
    stack.risk.mode = 'in_progress';
    const id = await create();
    await settledAs(id, 'failed');
    expect(riskCalls(id)).toHaveLength(ATTEMPTS);
    expect([...new Set(riskCalls(id).map((c) => c.headers['idempotency-key']))]).toEqual([`${id}:risk`]);
    const row = (await stack.service.getIntent(MC, 'test', id)) as { last_error: { code: string } };
    expect(row.last_error.code).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect(await terminalEvents(id)).toEqual(['payment_intent.failed']);
    expect(await escalations(id)).toEqual(['risk_unresolved']);
  });

  it('timeouts persistentes ⇒ mismo desenlace: failed/risk_unavailable, sin cargo, y el workflow TERMINÓ (no queda vivo ni en processing)', async () => {
    stack.risk.mode = 'hang';
    const id = await create();
    await settledAs(id, 'failed');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(await terminalEvents(id)).toEqual(['payment_intent.failed']);
    expect(await escalations(id)).toEqual(['risk_unresolved']);
    expect(await waitFor(async () => ((await workflowStatus(id)) === 'COMPLETED' ? 'COMPLETED' : undefined), 20_000, 'workflow COMPLETED')).toBe('COMPLETED');
  });
});

describe('inválido · lo que NO es una decisión de riesgo no se confunde con «rechazo definitivo» ni mata el workflow', () => {
  it('un 4xx declarado que no es una decisión (422) es un error de integración: fail-closed enseguida, sin reintentar, con constancia, y el workflow termina', async () => {
    stack.risk.mode = 'rejects';
    const id = await create();
    await settledAs(id, 'failed');
    expect(riskCalls(id)).toHaveLength(1);
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(await escalations(id)).toEqual(['risk_integration_error']);
    expect(await waitFor(async () => ((await workflowStatus(id)) === 'COMPLETED' ? 'COMPLETED' : undefined), 20_000, 'workflow COMPLETED')).toBe('COMPLETED');
  });

  it('`deny` y `review` en una respuesta válida SÍ son «no» definitivos: risk_denied, UNA llamada, sin reintentos ni constancia', async () => {
    for (const mode of ['deny', 'review'] as const) {
      stack.risk.reset();
      stack.risk.mode = mode;
      const id = await create();
      await settledAs(id, 'failed');
      expect(riskCalls(id)).toHaveLength(1);
      expect(((await stack.service.getIntent(MC, 'test', id)) as { last_error: { code: string } }).last_error.code).toBe('risk_denied');
      expect(await escalations(id)).toEqual([]);
    }
  });

  it('riesgo caído (503) sigue siendo fail-closed inmediato: failed/risk_unavailable', async () => {
    stack.risk.mode = 'down';
    const id = await create();
    await settledAs(id, 'failed');
    expect(((await stack.service.getIntent(MC, 'test', id)) as { last_error: { code: string } }).last_error.code).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });
});
