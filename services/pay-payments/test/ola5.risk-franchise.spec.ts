import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { loadConfig } from '../src/config';
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

  // Ola 5 (REVISION-DINERO F-A2): hasta aquí este caso afirmaba «sin constancia». Concedía un cobro SIN decisión de riesgo sin dejar rastro, así que no se podía re-cribar después. Ahora la
  // concesión deja la constancia durable `risk_franchise_granted` (más fuerte que antes; el resto del caso —requires_action, un cargo, riesgo no alcanzado— no cambia).
  it('correcto (no regresión) · conexión rechazada, primer intento, monto bajo el umbral ⇒ la franquicia PASA: requires_action y un cargo, CON la constancia risk_franchise_granted (F-A2)', async () => {
    const id = await h.create();
    await h.settledAs(id, 'requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect(await h.escalations(id)).toEqual(['risk_franchise_granted']);
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

/** Estado de un cobro y su motivo de cierre, para las aserciones de abajo. */
const constanciasOf = async (stack: Stack, id: string) =>
  (await stack.db.pool.query('SELECT kind, source_event_id, reason, current_status, incoming_status FROM intent_contradictions WHERE payment_intent_id = $1 ORDER BY id', [id])).rows as { kind: string; source_event_id: string; reason: string; current_status: string; incoming_status: string }[];

describe('F-A2 · cada concesión de la franquicia deja constancia durable, un log sin datos personales y un contador', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeAll(async () => {
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD, RISK_URL: await closedPortUrl() } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn') as unknown as typeof warn;
  });
  afterEach(() => {
    warn.mockRestore();
    metrics.disable();
  });

  it('correcto · constancia risk_franchise_granted (kind/motivo/estado), evento payment_intent.contradiction_detected en el outbox y log estructurado SIN el nombre del pagador', async () => {
    const id = `pi_${randomBytes(12).toString('hex')}`;
    await startDirectIntent(stack, { id, expiresInMs: 60_000, payerName: 'Persona Privada Ejemplo' });
    await h.settledAs(id, 'requires_action');
    expect(await constanciasOf(stack, id)).toEqual([{ kind: 'risk_franchise_granted', source_event_id: 'waived:risk_franchise_granted', reason: 'risk_unreachable_below_threshold', current_status: 'processing', incoming_status: 'waived' }]);
    const outbox = (await stack.db.pool.query("SELECT envelope FROM outbox_events WHERE type = 'payment_intent.contradiction_detected' AND aggregate_id = $1", [id])).rows as { envelope: { data: Record<string, unknown> } }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.envelope.data).toMatchObject({ payment_intent_id: id, kind: 'risk_franchise_granted', incoming_status: 'waived' });
    const granted = warn.mock.calls.filter(([message]: unknown[]) => (message as { event?: string } | null)?.event === 'risk_franchise_granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]![0]).toMatchObject({ event: 'risk_franchise_granted', payment_intent_id: id, merchant_id: MC, amount_minor: 10000, currency: 'BOB', threshold_minor: THRESHOLD });
    // Nada de datos personales (regla 90.2.1): ni el nombre del pagador ni el de la razón social del comercio en el log ni en la constancia.
    expect(JSON.stringify(granted)).not.toMatch(/Persona Privada|Comercio de Prueba/);
    expect(JSON.stringify(await constanciasOf(stack, id))).not.toMatch(/Persona Privada|Comercio de Prueba/);
  });

  it('correcto · el contador pay_payments_risk_franchise_granted_total suma 1 por concesión', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    try {
      const id = await h.create();
      await h.settledAs(id, 'requires_action');
      await provider.forceFlush();
      const points = exporter.getMetrics().flatMap((m) => m.scopeMetrics).flatMap((scope) => scope.metrics).filter((metric) => metric.descriptor.name === 'pay_payments_risk_franchise_granted_total').flatMap((metric) => metric.dataPoints as { value: number; attributes: Record<string, unknown> }[]);
      expect(points.map((point) => point.value)).toEqual([1]);
      expect(points[0]!.attributes).toEqual({ currency: 'BOB', method: 'qr' });
    } finally {
      await provider.shutdown();
    }
  });

  it('límite · en el umbral o por encima NO concede: sin constancia, sin log de concesión y sin cargo', async () => {
    const id = await h.create({ ...QR, amount_minor: Number(THRESHOLD) });
    await h.settledAs(id, 'failed');
    expect(await constanciasOf(stack, id)).toEqual([]);
    expect(warn.mock.calls.filter(([message]: unknown[]) => (message as { event?: string } | null)?.event === 'risk_franchise_granted')).toHaveLength(0);
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });

  it('inválido · si la constancia no se puede escribir NO se concede sin rastro: el reintento cierra fail-closed y no hay cargo', async () => {
    // Se simula la falla de la base en el momento de registrar la constancia: la primera escritura falla y la actividad se reintenta (attempt 2).
    const original = stack.deps.tx;
    let failedOnce = false;
    (stack.deps as { tx: typeof original }).tx = (async (work: Parameters<typeof original>[0]) => {
      const probe = String(work);
      if (!failedOnce && probe.includes('waived:')) {
        failedOnce = true;
        throw new Error('constancia no escrita (simulado)');
      }
      return original(work);
    }) as typeof original;
    try {
      const id = await h.create();
      await h.settledAs(id, 'failed');
      expect(failedOnce).toBe(true);
      expect(await h.code(id)).toBe('risk_unavailable');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect((await constanciasOf(stack, id)).map((c) => c.kind)).toEqual(['risk_unresolved']); // sin `risk_franchise_granted`: nunca se concedió
    } finally {
      (stack.deps as { tx: typeof original }).tx = original;
    }
  });
});

describe('F-A2 · guarda de configuración: la franquicia no se admite bajo PAY_MODE=live', () => {
  const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const base = { ...(process.env as Record<string, string>), ...extra };
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete base[k];
    return base;
  };

  it('inválido · live + RISK_ALLOW_BELOW_THRESHOLD=true ⇒ NO arranca (con umbral > 0 y también con el umbral 0 que la deja inerte), y el mensaje nombra la variable', () => {
    expect(() => loadConfig(env({ PAY_MODE: 'live', RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD }))).toThrow(/PAY_MODE=live: RISK_ALLOW_BELOW_THRESHOLD=true no está permitido/);
    expect(() => loadConfig(env({ PAY_MODE: 'live', RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: '0' }))).toThrow(/RISK_ALLOW_BELOW_THRESHOLD=true no está permitido/);
  });

  it('correcto · live con la franquicia apagada (false, vacía o sin definir) arranca y queda apagada; sandbox con la franquicia encendida arranca', () => {
    for (const value of ['false', '', undefined]) expect(loadConfig(env({ PAY_MODE: 'live', RISK_ALLOW_BELOW_THRESHOLD: value })).policy.riskAllowBelowThreshold).toBe(false);
    expect(loadConfig(env({ PAY_MODE: 'sandbox', RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD })).policy).toMatchObject({ riskAllowBelowThreshold: true, riskFailClosedThresholdMinor: 1_000_000n });
  });

  it('límite · con el umbral por defecto (0) la franquicia no hace nada aunque esté encendida en sandbox: amount >= 0 siempre cierra (documentado)', async () => {
    const stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: '0', RISK_URL: await closedPortUrl() } });
    try {
      await seedMerchant(stack, MC);
      const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
      await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 60_000, 'failed');
      expect(stack.connectors.chargeFor(id)).toBeUndefined();
      expect(await constanciasOf(stack, id)).toEqual([]);
    } finally {
      await stack.stop();
    }
  });
});

describe('F-A1 · un breaker abierto por los 5xx de OTROS cobros NO es prueba de que pay-risk esté caído: no activa la franquicia', () => {
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  const breakerOf = (s: Stack) => (s.deps.clients.risk as unknown as { http: { breaker: { state: string } } }).http.breaker;
  beforeAll(async () => {
    // Umbral 3 y reapertura a los 2 minutos: el breaker sigue abierto durante toda la prueba aunque riesgo ya esté sano (el escenario de la sonda A de la re-revisión).
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_ALLOW_BELOW_THRESHOLD: 'true', RISK_FAIL_CLOSED_THRESHOLD_MINOR: THRESHOLD, CIRCUIT_FAILURE_THRESHOLD: '3', CIRCUIT_RESET_MS: '120000' } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => stack.stop());
  afterEach(() => stack.risk.reset());

  it('inválido (la sonda A) · un pagador SANCIONADO que entra con el breaker abierto NO pasa: failed/risk_unavailable, SIN cargo, SIN constancia de franquicia (antes: requires_action y cargo sin ninguna llamada a riesgo)', async () => {
    stack.risk.sanctions.add('persona sancionada');
    stack.risk.mode = 'down';
    const others = [h.create(), h.create(), h.create()];
    await Promise.all(others);
    await waitFor(async () => (breakerOf(stack).state === 'open' ? true : undefined), 30_000, 'breaker abierto');
    stack.risk.mode = 'allow'; // riesgo vuelve a estar sano; el breaker sigue abierto
    const before = stack.risk.callCount;
    const sanctioned = `pi_${randomBytes(12).toString('hex')}`;
    await startDirectIntent(stack, { id: sanctioned, expiresInMs: 120_000, payerName: 'Persona Sancionada' });
    await h.settledAs(sanctioned, 'failed');
    expect(await h.code(sanctioned)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(sanctioned)).toBeUndefined();
    expect(stack.risk.callCount - before).toBe(0); // riesgo no recibió ni una llamada de este cobro: se cerró sin evaluar, pero CERRADO
    expect(await constanciasOf(stack, sanctioned)).toEqual([]); // nada se concedió, no hay constancia de franquicia
  });

  it('control · mientras el breaker está abierto ningún cobro bajo el umbral recibe la franquicia (ninguna constancia risk_franchise_granted en toda la base de la prueba)', async () => {
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    const { rows } = await stack.db.pool.query("SELECT count(*)::int AS n FROM intent_contradictions WHERE kind = 'risk_franchise_granted'");
    expect(rows[0].n).toBe(0);
  });
});

/** Servidor HTTP mínimo que hace de pay-risk con respuestas a la medida (cuerpo cortado, 429…): fuera del doble contractual a propósito. */
const listenRisk = async (handler: (req: IncomingMessage, res: ServerResponse, n: number) => void): Promise<{ url: string; calls: () => { key: string | undefined }[]; close: () => Promise<void> }> => {
  const seen: { key: string | undefined }[] = [];
  const server: Server = createHttpServer((req, res) => {
    req.resume();
    seen.push({ key: req.headers['idempotency-key'] as string | undefined });
    handler(req, res, seen.length);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
};
const allowBody = (paymentIntentId: string) => JSON.stringify({ id: `ra_${paymentIntentId.slice(3, 17)}`, object: 'risk_assessment', payment_intent_id: paymentIntentId, decision: 'allow', reason_code: 'ok', rule_version: 1, screened: true, created_at: new Date().toISOString() });

describe('F-A3 · un cuerpo cortado tras los headers 201 cierra el intento por la política (no queda en processing en bucle)', () => {
  let risk: Awaited<ReturnType<typeof listenRisk>>;
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    risk = await listenRisk((req) => {
      req.socket.write('HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"id":"ra_x","deci');
      setTimeout(() => req.socket.destroy(), 20);
    });
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_URL: risk.url } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => {
    await stack.stop();
    await risk.close();
  });

  it('inválido · cuerpo cortado persistente ⇒ failed/risk_unavailable (agotada la política), SIN cargo, con constancia risk_unresolved; siempre la MISMA clave', async () => {
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect((await constanciasOf(stack, id)).map((c) => c.kind)).toEqual(['risk_unresolved']);
    expect([...new Set(risk.calls().map((c) => c.key))]).toEqual([`${id}:risk`]);
    expect(risk.calls().length).toBeGreaterThanOrEqual(ATTEMPTS);
  });
});

describe('F-A3 · un 2xx de riesgo sin una decisión legible (cuerpo vacío) es ambiguo: se cierra por la política, no queda reintentando', () => {
  let risk: Awaited<ReturnType<typeof listenRisk>>;
  let stack: Stack;
  let h: ReturnType<typeof harness>;
  beforeAll(async () => {
    risk = await listenRisk((_req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end());
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_URL: risk.url } });
    await seedMerchant(stack, MC);
    h = harness(stack);
  });
  afterAll(async () => {
    await stack.stop();
    await risk.close();
  });

  it('inválido · 201 con cuerpo vacío persistente ⇒ failed/risk_unavailable, SIN cargo, con constancia risk_unresolved (antes: TypeError crudo, intento en processing)', async () => {
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
    expect((await constanciasOf(stack, id)).map((c) => c.kind)).toEqual(['risk_unresolved']);
  });
});

describe('F-A5 · un 429 rate_limited de riesgo es transitorio: se reintenta con la MISMA clave dentro de la política, y sigue siendo fail-closed', () => {
  const rateLimited = (res: ServerResponse) => res.writeHead(429, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: 'urn:alovida:pay:problem:rate_limited', title: 'rate_limited', status: 429, code: 'rate_limited' }));
  let stack: Stack | undefined;
  let risk: Awaited<ReturnType<typeof listenRisk>> | undefined;
  afterEach(async () => {
    await stack?.stop();
    await risk?.close();
    stack = undefined;
    risk = undefined;
  });
  const boot = async (limited: number | 'always') => {
    risk = await listenRisk((req, res, n) => {
      if (limited === 'always' || n <= limited) return rateLimited(res);
      return res.writeHead(201, { 'content-type': 'application/json' }).end(allowBody(String(lastIntent)));
    });
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_URL: risk.url } });
    await seedMerchant(stack, MC);
    return harness(stack);
  };
  let lastIntent = '';

  it('correcto · dos 429 y luego `allow` ⇒ el cobro avanza UNA vez, con la misma clave y sin constancia', async () => {
    lastIntent = `pi_${randomBytes(12).toString('hex')}`;
    const h = await boot(2);
    await startDirectIntent(stack!, { id: lastIntent, expiresInMs: 60_000 });
    await h.settledAs(lastIntent, 'requires_action');
    expect(stack!.connectors.chargeCreations.get(lastIntent)).toBe(1);
    expect([...new Set(risk!.calls().map((c) => c.key))]).toEqual([`${lastIntent}:risk`]);
    expect(risk!.calls()).toHaveLength(3);
    expect(await h.escalations(lastIntent)).toEqual([]);
  });

  it('límite/inválido · 429 persistente ⇒ failed/risk_unavailable (agotada la política), SIN cargo, con constancia risk_unresolved', async () => {
    lastIntent = `pi_${randomBytes(12).toString('hex')}`;
    const h = await boot('always');
    await startDirectIntent(stack!, { id: lastIntent, expiresInMs: 60_000 });
    await h.settledAs(lastIntent, 'failed');
    expect(await h.code(lastIntent)).toBe('risk_unavailable');
    expect(stack!.connectors.chargeFor(lastIntent)).toBeUndefined();
    expect(await h.escalations(lastIntent)).toEqual(['risk_unresolved']);
    expect(risk!.calls().length).toBeGreaterThanOrEqual(ATTEMPTS);
  });

  it('control (F-A5 decidido) · conexión rechazada con la franquicia apagada sigue cerrando al instante, sin reintentar ni constancia', async () => {
    const url = await closedPortUrl();
    stack = await startStack({ env: { ACTIVITY_MAX_ATTEMPTS: String(ATTEMPTS), RISK_URL: url } });
    await seedMerchant(stack, MC);
    const h = harness(stack);
    const started = Date.now();
    const id = await h.create();
    await h.settledAs(id, 'failed');
    expect(Date.now() - started).toBeLessThan(5_000); // sin los ~13 s de la política de reintentos
    expect(await h.code(id)).toBe('risk_unavailable');
    expect(await h.escalations(id)).toEqual([]);
  });
});
