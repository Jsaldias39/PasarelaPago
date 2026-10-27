import { performance } from 'node:perf_hooks';
import { createTestContext, type TestContext } from './support/app';
import { assessmentBody, post, publishRules, rows, CLEAN_NAME, SANCTIONED_ORG } from './support/http';

let ctx: TestContext;
beforeAll(async () => {
  // Con el tiempo máximo de cribado de producción (200 ms): es el que importa para la latencia.
  ctx = await createTestContext({ settings: { screeningTimeoutMs: 200 } });
  // Todas las reglas activas: es el caso más caro (consultas de historia con candados) — valores de prueba, no de negocio.
  await publishRules(ctx, {
    max_amount_minor: 100_000_000,
    merchant_daily_amount_minor: 9_000_000_000,
    payer_daily_amount_minor: 9_000_000_000,
    payer_velocity: { max: 100000, window_seconds: 3600 },
    merchant_velocity: { max: 100000, window_seconds: 3600 },
    hours: { from: 0, to: 24 },
  });
});
afterAll(async () => ctx.close());

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const summary = (label: string, times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const line = { label, n: sorted.length, p50: +percentile(sorted, 50).toFixed(1), p95: +percentile(sorted, 95).toFixed(1), p99: +percentile(sorted, 99).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
  process.stdout.write(`LATENCIA ${JSON.stringify(line)}\n`);
  return line;
};

// Medido en el cliente (supertest sobre HTTP real en loopback): incluye Nest, validación, idempotencia, Watchman REAL, candados y escritura.
async function measure(count: number, concurrency: number, build: (i: number) => Record<string, unknown>): Promise<number[]> {
  const times: number[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      const started = performance.now();
      const res = await post(ctx, build(i));
      times.push(performance.now() - started);
      expect({ i, status: res.status }).toEqual({ i, status: 201 });
      expect(['allow', 'review', 'deny']).toContain(res.body.decision);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return times;
}

describe('POST /assessments: p99 < 300 ms medido (P5.H2.M4) contra el Watchman REAL (v2-static) y Postgres real', () => {
  const body = (i: number) => assessmentBody({ payer_fingerprint: `huella-${i % 7}`, merchant_id: `mc_latency${i % 5}abcdefghijk`.slice(0, 19), screening: { name: i % 10 === 0 ? SANCTIONED_ORG : CLEAN_NAME, entity_type: 'business' } });
  const bodyTwoSearches = (i: number) => assessmentBody({ payer_fingerprint: `huella-${i % 7}`, screening: { name: CLEAN_NAME } });

  it('secuencial, 1 cliente, 1 búsqueda en Watchman (entity_type conocido): ≥ 200 llamadas', async () => {
    await measure(5, 1, body); // calentamiento (conexiones, JIT)
    const line = summary('secuencial-1-busqueda', await measure(200, 1, body));
    expect(line.n).toBe(200);
    expect(line.p99).toBeLessThan(300);
  });

  it('secuencial, 1 cliente, 2 búsquedas en Watchman (tipo desconocido: persona y empresa): ≥ 200 llamadas', async () => {
    await measure(5, 1, bodyTwoSearches);
    const line = summary('secuencial-2-busquedas', await measure(200, 1, bodyTwoSearches));
    expect(line.p99).toBeLessThan(300);
  });

  it('concurrencia moderada (4 clientes en paralelo), ≥ 400 llamadas — INFORMATIVA: el Watchman (monohilo por búsqueda) es el cuello de botella', async () => {
    // El DoD de P5.H2.M4 son las dos pruebas secuenciales. Esta mide qué pasa con 4 clientes en una máquina compartida de 4 vCPU:
    // el p99 se acerca al presupuesto por la saturación de Watchman, no del servicio. Se deja una guarda al doble del presupuesto
    // para detectar regresiones grandes, y la cifra real queda en la evidencia.
    const line = summary('concurrente-4', await measure(400, 4, body));
    expect(line.p99).toBeLessThan(600);
  });

  it('cada llamada medida dejó su rastro, con su duración interna registrada', async () => {
    const [{ n, slow, unscreened }] = await rows(ctx, 'SELECT count(*)::int AS n, count(*) FILTER (WHERE duration_ms >= 300)::int AS slow, count(*) FILTER (WHERE NOT screened)::int AS unscreened FROM risk_assessments');
    expect(n).toBeGreaterThanOrEqual(805);
    process.stdout.write(`LATENCIA-RASTRO ${JSON.stringify({ n, duracion_interna_ge_300ms: slow, sin_cribar_por_timeout: unscreened })}\n`);
    // Menos del 1 %: es el criterio del p99. Las llamadas sin cribar son cribados que superaron los 200 ms (decisión `review`, nunca `allow`).
    expect(slow / n).toBeLessThan(0.01);
  });
});
