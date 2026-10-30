import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { key, MC, seedMerchant, startDirectIntent, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * Ola 5 · P3 · REVISION-DINERO F1 y F7 (CLAUDE.md regla 11: un resultado ambiguo —timeout, corte, 5xx— NO prueba que la orden no se ejecutó; nunca se concede por ambigüedad).
 *
 * Con `RISK_ALLOW_BELOW_THRESHOLD=true` el cobro bajo el umbral pasaba sin decisión de riesgo cuando `assessRisk` veía un 5xx «puro». Tres caminos lo dejaban pasar con una evaluación VIVA
 * (que puede volver como `deny`): A) un timeout y, dentro del MISMO intento del HttpClient, un 503 (solo se veía el último error); B) un 5xx o una respuesta fuera del contrato
 * (`unexpected_response`) tratados como «no hay evaluación»; C) `attempt` vuelve a 1 en una ronda nueva de la actividad. Y F7: un `allow` con `screened:false` se concedía.
 * Ahora la franquicia exige PRUEBA de que ninguna llamada llegó (conexión rechazada / DNS / breaker abierto), en la primera ronda y el primer intento; todo lo demás se reintenta con
 * la MISMA clave y, agotada la política, cierra `failed/risk_unavailable` con constancia. Con la franquicia APAGADA (defecto) todo sigue fail-closed: se prueba en los mismos casos.
 * Riesgo es un DOBLE declarado que valida `internal-risk-v1` (regla 65). Tres niveles: correcto, límite e inválido.
 */
const ATTEMPTS = 4;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const THRESHOLD = '1000000';

const harness = (stack: Stack) => {
  const create = async (body: Record<string, unknown> = QR): Promise<string> => (await stack.service.createIntent(MC, 'test', key(), body)).body.id as string;
  const settledAs = (id: string, ...statuses: string[]) => waitFor(async () => { const s = await statusOf(stack, id); return s && statuses.includes(s) ? s : undefined; }, 60_000, `${id} → ${statuses.join('|')}`);
  const riskCalls = (id: string) => stack.risk.server.calls.filter((c) => (c.body as { payment_intent_id?: string }).payment_intent_id === id);
  const escalations = async (id: string) => (await stack.db.pool.query('SELECT kind FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows.map((r: { kind: string }) => r.kind);
  const code = async (id: string) => ((await stack.service.getIntent(MC, 'test', id)) as { last_error: { code: string } }).last_error.code;
  const keys = (id: string) => [...new Set(riskCalls(id).map((c) => c.headers['idempotency-key']))];
  return { create, settledAs, riskCalls, escalations, code, keys };
};

describe('franquicia ENCENDIDA (RISK_ALLOW_BELOW_THRESHOLD=true, umbral 1.000.000), riesgo alcanzable: nada ambiguo la activa', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());
  afterEach(() => stack.risk.reset());

  describe('F1-A · timeout y, DENTRO del mismo intento del cliente, un 503: la evaluación del primer envío pudo quedar viva', () => {
    it('inválido · la evaluación viva vuelve como `deny` ⇒ risk_denied, SIN cargo (antes el cobro pasaba por la franquicia y riesgo lo denegaba después)', async () => {
      stack.risk.mode = { script: ['hang', 'down'], then: 'deny' };
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_denied');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(stack.connectors.chargeCreations.get(id) ?? 0).toBe(0);
      expect(h.riskCalls(id).length).toBeGreaterThanOrEqual(3); // timeout, 503 y la decisión
      expect(h.keys(id)).toEqual([`${id}:risk`]); // siempre la MISMA clave
      expect(await h.escalations(id)).toEqual([]);
    });

    it('correcto · la evaluación viva vuelve como `allow` ⇒ el cobro avanza UNA vez, con la misma clave', async () => {
      stack.risk.mode = { script: ['hang', 'down'], then: 'allow' };
      const id = await h.create();
      await h.settledAs(id, 'requires_action');
      expect(stack.connectors.chargeCreations.get(id)).toBe(1);
      expect(h.keys(id)).toEqual([`${id}:risk`]);
      expect(h.riskCalls(id).length).toBeGreaterThanOrEqual(3);
    });

    it('límite · persistente (timeout + 503 en cada intento) ⇒ se agota la política: failed/risk_unavailable, SIN cargo, con constancia', async () => {
      stack.risk.mode = { script: Array.from({ length: 2 * ATTEMPTS }, (_, i) => (i % 2 === 0 ? ('hang' as const) : ('down' as const))), then: 'deny' };
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(await h.escalations(id)).toEqual(['risk_unresolved']);
    });
  });

  describe('F1-B · un 5xx o una respuesta fuera del contrato NO prueban que riesgo no evaluó', () => {
    it('correcto · un 5xx (los dos envíos del cliente) y luego `allow` ⇒ NO pasa por la franquicia: se reintenta con la misma clave y avanza UNA vez (3 llamadas, no 2)', async () => {
      stack.risk.mode = { script: ['down', 'down'], then: 'allow' };
      const id = await h.create();
      await h.settledAs(id, 'requires_action');
      expect(h.riskCalls(id)).toHaveLength(3);
      expect(h.keys(id)).toEqual([`${id}:risk`]);
      expect(stack.connectors.chargeCreations.get(id)).toBe(1);
      expect(await h.escalations(id)).toEqual([]);
    });

    it('límite · 5xx persistente ⇒ failed/risk_unavailable tras agotar los intentos, SIN cargo, con constancia (no hay franquicia)', async () => {
      stack.risk.mode = 'down';
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(h.riskCalls(id).length).toBeGreaterThanOrEqual(ATTEMPTS);
      expect(await h.escalations(id)).toEqual(['risk_unresolved']);
    });

    it('inválido · un 4xx SIN el cuerpo de error del contrato (`unexpected_response`: proxy, service-auth mal puesto) ⇒ failed/risk_unavailable, SIN cargo, con constancia: no deja pasar todo el tráfico bajo el umbral', async () => {
      stack.risk.mode = 'unexpected';
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(await h.escalations(id)).toEqual(['risk_unresolved']);
    });
  });

  describe('F7 · `allow` con `screened:false` (el contrato dice que no ocurre) no se concede', () => {
    it('correcto · dos `allow` sin cribar y luego un `allow` normal ⇒ se reintenta con la misma clave y el cobro avanza UNA vez', async () => {
      stack.risk.mode = { unscreenedAllowFirst: 2 };
      const id = await h.create();
      await h.settledAs(id, 'requires_action');
      expect(h.riskCalls(id)).toHaveLength(3);
      expect(h.keys(id)).toEqual([`${id}:risk`]);
      expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    });

    it('límite/inválido · `allow` sin cribar PERSISTENTE ⇒ failed/risk_unavailable, SIN cargo, con constancia (aunque el monto esté bajo el umbral)', async () => {
      stack.risk.mode = 'allow_unscreened';
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(h.riskCalls(id)).toHaveLength(ATTEMPTS);
      expect(await h.escalations(id)).toEqual(['risk_unresolved']);
    });
  });
});

describe('franquicia APAGADA (defecto): todo sigue fail-closed en los mismos casos', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS) } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());
  afterEach(() => stack.risk.reset());

  it('F1-A · timeout y 503 en el mismo intento y luego `deny` ⇒ risk_denied, sin cargo', async () => {
    stack.risk.mode = { script: ['hang', 'down'], then: 'deny' };
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_denied');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });

  it('F1-B · 5xx persistente y respuesta fuera del contrato ⇒ failed/risk_unavailable, sin cargo', async () => {
    for (const mode of ['down', 'unexpected'] as const) {
      stack.risk.reset();
      stack.risk.mode = mode;
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
    }
  });

  it('F7 · `allow` sin cribar ⇒ NO se concede: failed/risk_unavailable, sin cargo, con constancia', async () => {
    stack.risk.mode = 'allow_unscreened';
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(await h.escalations(id)).toEqual(['risk_unresolved']);
  });

  it('control · una decisión válida sigue igual: `allow` avanza y `deny` es risk_denied', async () => {
    const allowed = await h.create();
    await h.settledAs(allowed, 'requires_action');
    stack.risk.mode = 'deny';
    const denied = await h.create();
    await h.settledAs(denied, 'failed');
    expect(await h.code(denied)).toBe('risk_denied');
  });
});

/** Un puerto en el que nadie escucha: la conexión se rechaza (`ECONNREFUSED`), que es la prueba de que la petición no salió. */
const closedPortUrl = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
};

describe('franquicia ENCENDIDA y pay-risk PROBADAMENTE inalcanzable (conexión rechazada): única causa que la activa', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD, RISK_URL: await closedPortUrl() } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());

  it('correcto (no regresión) · conexión rechazada, primer intento, monto bajo el umbral ⇒ la franquicia PASA: requires_action y un cargo, sin constancia', async () => {
    const id = await h.create();
    await h.settledAs(id, 'requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(await h.escalations(id)).toEqual([]);
    expect(stack.risk.callCount).toBe(0); // el doble de riesgo nunca fue alcanzado
  });

  it('límite · en el umbral (1.000.000) o por encima ⇒ fail-closed aunque la conexión se haya rechazado: failed/risk_unavailable, sin cargo, sin constancia', async () => {
    const id = await h.create({ ...QR, amount_minor: Number(THRESHOLD) });
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(await h.escalations(id)).toEqual([]);
  });

  it('F1-C · hubo una ronda anterior de la actividad (`attempt` vuelve a 1 pero la base guarda `ambiguous:risk_unknown`) ⇒ NO se asume que nunca salió: failed/risk_unavailable, sin cargo, con constancia', async () => {
    const id = `pi_${randomBytes(12).toString('hex')}`;
    // La constancia que deja el workflow (`escalate('risk_unknown')`) cuando una ronda de assessRisk agota sus reintentos: aquí se siembra como la dejaría esa ronda anterior.
    await stack.db.pool.query("INSERT INTO intent_contradictions (payment_intent_id, current_status, incoming_status, source_event_id, kind, reason) VALUES ($1, 'processing', 'ambiguous', 'ambiguous:risk_unknown', 'risk_unknown', 'ambiguous_result_keeps_state')", [id]);
    await startDirectIntent(stack, { id, expiresInMs: 60_000 });
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect(await h.escalations(id)).toEqual(['risk_unknown', 'risk_unresolved']);
  });
});

describe('franquicia APAGADA y pay-risk inalcanzable: fail-closed enseguida, como siempre', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_URL: await closedPortUrl() } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());

  it('inválido · conexión rechazada sin franquicia ⇒ failed/risk_unavailable, sin cargo', async () => {
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });
});
