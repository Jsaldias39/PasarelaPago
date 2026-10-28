import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CRITERIA, evaluate, type Measured } from './criteria.ts';
import { checkCaptureLines, readPending, type StatementLine } from './ledger-check.ts';
import { arrivalOffsetsMs, cumulativeArrivals, validatePlan } from './plan.ts';
import { buildReport, exitCodeOf, renderReport } from './report.ts';
import { runLoad, type LoadConfig } from './runner.ts';
import { parseDockerStats, parseMachineStat, parseProcStat, type CpuReport } from './sampler.ts';
import { percentile, summarize } from './stats.ts';

/** Pruebas del runner de carga SIN carga real: el instrumento tiene que medir bien y detectar fallas ANTES de usarlo contra el stack (regla: el instrumento se prueba). */

describe('estadística — nivel CORRECTO / LÍMITE / INVÁLIDO', () => {
  it('percentil por rango más cercano', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(v, 50), percentile(v, 95), percentile(v, 99), percentile(v, 100), percentile(v, 0)]).toEqual([50, 95, 99, 100, 1]);
    expect(percentile([7], 99)).toBe(7);
  });
  it('lista vacía ⇒ null (no se inventa un número) y un percentil fuera de rango lanza', () => {
    expect(percentile([], 99)).toBeNull();
    expect(summarize([])).toMatchObject({ n: 0, p99: null, mean: null });
    expect(() => percentile([1], 101)).toThrow();
    expect(() => percentile([1], -1)).toThrow();
  });
  it('el p99 de 1000 valores con 11 lentos (1,1 %) es lento: la cola no se promedia; con 10 (1 %) justo no llega', () => {
    const v = [...Array.from({ length: 989 }, () => 10), ...Array.from({ length: 11 }, () => 5000)];
    expect(summarize(v).p99).toBe(5000);
    expect(summarize(v).p95).toBe(10);
    expect(summarize([...Array.from({ length: 990 }, () => 10), ...Array.from({ length: 10 }, () => 5000)]).p99).toBe(10);
  });
});

describe('plan de llegadas (generador abierto con rampa)', () => {
  it('rampa de 2 s a 10 rps y 4 s en total ⇒ 30 llegadas, la última segundo con 10, ordenadas y dentro de la ventana', () => {
    const plan = { peakRps: 10, rampSeconds: 2, durationSeconds: 4 };
    expect(cumulativeArrivals(plan, 4)).toBe(30);
    const offsets = arrivalOffsetsMs(plan);
    expect(offsets).toHaveLength(30);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(offsets[0]!).toBeGreaterThan(0);
    expect(offsets.at(-1)!).toBeLessThanOrEqual(4000);
    expect(offsets.filter((t) => t >= 3000 && t < 4000)).toHaveLength(10); // a pleno
    expect(offsets.filter((t) => t < 1000)).toHaveLength(2); // el primer segundo de la rampa lleva ~2,5 rps medios
  });
  it('sin rampa la tasa es constante', () => {
    const offsets = arrivalOffsetsMs({ peakRps: 5, rampSeconds: 0, durationSeconds: 3 });
    expect(offsets).toHaveLength(15);
    expect(offsets[1]! - offsets[0]!).toBe(200);
  });
  it('el plan por defecto de T-01 (25 rps, rampa de 60 s, 5 min) planifica 22.500 + 750 pedidos', () => {
    const plan = { peakRps: 25, rampSeconds: 60, durationSeconds: 300 };
    expect(arrivalOffsetsMs(plan)).toHaveLength(Math.floor(25 * 30 + 25 * 240));
  });
  it('planes inválidos se rechazan', () => {
    for (const bad of [{ peakRps: 0, rampSeconds: 1, durationSeconds: 5 }, { peakRps: 5, rampSeconds: -1, durationSeconds: 5 }, { peakRps: 5, rampSeconds: 10, durationSeconds: 5 }, { peakRps: 5, rampSeconds: 1, durationSeconds: 0 }, { peakRps: Number.NaN, rampSeconds: 1, durationSeconds: 5 }]) {
      expect(() => validatePlan(bad)).toThrow();
    }
  });
});

const GOOD: Measured = { sent: 10_000, answered: 10_000, status5xx: 0, status429: 0, noResponse: 0, runnerDropped: 0, p99Ms: 350, sendLagP99Ms: 4, created: 9_800, stuck: 0, doubleEntries: 0, idempotencyViolations: 0, missingEntries: 0, machineBusyPercentAvg: 60 };

describe('criterio de aceptación (el mismo de CARGA.md) — nivel CORRECTO / LÍMITE / INVÁLIDO', () => {
  it('el criterio escrito es el acordado: p99 < 2 s, 5xx < 0,1 %, ningún colgado, ningún doble asiento', () => {
    expect(CRITERIA).toEqual({ p99MaxMs: 2000, serverErrorRateMax: 0.001, stuckMax: 0, doubleEntriesMax: 0 });
  });
  it('todo dentro del criterio y sin reservas ⇒ APRUEBA', () => {
    expect(evaluate(GOOD)).toMatchObject({ verdict: 'APRUEBA', caveats: [] });
  });
  it.each([
    ['p99 = 2000 ms (el criterio es estricto: < 2 s)', { p99Ms: 2000 }],
    ['p99 de 5 s', { p99Ms: 5000 }],
    ['5xx = 0,1 % exacto (estricto)', { status5xx: 10 }],
    ['5xx de 1 %', { status5xx: 100 }],
    ['un intento colgado', { stuck: 1 }],
    ['un doble asiento', { doubleEntries: 1 }],
    ['una clave de idempotencia que devolvió dos intentos', { idempotencyViolations: 1 }],
  ])('LÍMITE — %s ⇒ NO APRUEBA', (_name, patch) => {
    expect(evaluate({ ...GOOD, ...patch }).verdict).toBe('NO_APRUEBA');
  });
  it('justo debajo del límite (5xx 0,09 %, p99 1999 ms) ⇒ APRUEBA', () => {
    expect(evaluate({ ...GOOD, status5xx: 9, p99Ms: 1999 }).verdict).toBe('APRUEBA');
  });
  it('los pedidos SIN respuesta son ambiguos (regla 11): no cuentan como 5xx, pero se avisan y no se certifica', () => {
    const e = evaluate({ ...GOOD, answered: 9_900, noResponse: 100 });
    expect(e.checks.find((c) => c.name === 'errores 5xx')?.result).toBe('PASA');
    expect(e.caveats.join(' ')).toMatch(/AMBIGUOS/);
  });
  it.each([
    ['429 del borde: parte de la carga no llegó', { status429: 5 }],
    ['el generador descartó pedidos', { runnerDropped: 3 }],
    ['el generador se atrasó (p99 de salida > 100 ms)', { sendLagP99Ms: 400 }],
    ['asientos faltantes al leer el ledger', { missingEntries: 2 }],
  ])('%s ⇒ NO CONCLUYENTE aunque nada falle', (_name, patch) => {
    expect(evaluate({ ...GOOD, ...patch }).verdict).toBe('NO_CONCLUYENTE');
  });
  it('lo NO MEDIDO nunca es verde: sin ledger y sin respuestas ⇒ NO CONCLUYENTE; con una falla real ⇒ NO APRUEBA igual', () => {
    expect(evaluate({ ...GOOD, doubleEntries: null, missingEntries: null }).verdict).toBe('NO_CONCLUYENTE');
    expect(evaluate({ ...GOOD, answered: 0, p99Ms: null }).verdict).toBe('NO_CONCLUYENTE');
    expect(evaluate({ ...GOOD, doubleEntries: null, missingEntries: null, stuck: 2 }).verdict).toBe('NO_APRUEBA');
  });
  it('la máquina saturada se declara como reserva', () => {
    expect(evaluate({ ...GOOD, machineBusyPercentAvg: 97 }).caveats.join(' ')).toMatch(/saturada/);
  });
});

describe('asientos del ledger (pura)', () => {
  const credit = (ref: string, amount: number): StatementLine => ({ business_ref: ref, direction: 'credit', amount_minor: amount });
  const intents = [{ id: 'pi_a', merchantId: 'mc_1', netMinor: 9700 }, { id: 'pi_b', merchantId: 'mc_1', netMinor: 9700 }, { id: 'pi_c', merchantId: 'mc_2', netMinor: 9700 }];
  it('CORRECTO: un crédito de captura por intento ⇒ sin duplicados ni faltantes', () => {
    const lines = new Map([['mc_1', [credit('pi_a:capture', 9700), credit('pi_b:capture', 9700)]], ['mc_2', [credit('pi_c:capture', 9700)]]]);
    expect(checkCaptureLines(intents, lines)).toMatchObject({ doubleEntries: 0, missingEntries: 0, amountMismatches: 0, linesRead: 3 });
  });
  it('LÍMITE: un asiento repetido, uno faltante y un importe distinto se detectan; débitos y otras operaciones se ignoran', () => {
    const lines = new Map<string, StatementLine[]>([
      ['mc_1', [credit('pi_a:capture', 9700), credit('pi_a:capture', 9700), { business_ref: 'pi_b:capture', direction: 'debit', amount_minor: 9700 }, credit('pi_x:refund', 100)]],
      ['mc_2', [credit('pi_c:capture', 9000)]],
    ]);
    expect(checkCaptureLines(intents, lines)).toMatchObject({ doubleEntries: 1, missingEntries: 1, amountMismatches: 1 });
  });
  it('el mismo business_ref en el pending de OTRO comercio no cuenta como asiento de este', () => {
    const lines = new Map([['mc_2', [credit('pi_a:capture', 9700)]]]);
    expect(checkCaptureLines([intents[0]!], lines).missingEntries).toBe(1);
  });
  it('INVÁLIDO: sin intentos ni líneas no hay nada que contar', () => {
    expect(checkCaptureLines([], new Map())).toMatchObject({ doubleEntries: 0, missingEntries: 0, checkedIntents: 0 });
  });
});

describe('lectores de CPU', () => {
  it('/proc/<pid>/stat con espacios y paréntesis en el nombre del comando', () => {
    const stat = '1234 (node (worker) x) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 120 0 0 20 0 11 0 5000 1000000 100 18446744073709551615';
    expect(parseProcStat(stat)).toEqual({ ticks: 370 });
    expect(parseProcStat('basura')).toBeNull();
  });
  it('/proc/stat de la máquina: total y ociosos (idle + iowait)', () => {
    expect(parseMachineStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1 1')).toEqual({ total: 1000, idle: 850 });
    expect(parseMachineStat('')).toBeNull();
  });
  it('docker stats por contenedor', () => {
    const map = parseDockerStats('pay-pay-edge-1 37.50%\npay-pay-ledger-1 120.00%\nlinea rara\n');
    expect(map.get('pay-pay-edge-1')).toBe(37.5);
    expect(map.get('pay-pay-ledger-1')).toBe(120);
    expect(map.size).toBe(2);
  });
});

// ───────────── el runner contra un «borde» falso con fallas inyectables ─────────────

interface Fault {
  fail5xxEvery?: number;
  rate429From?: number;
  neverTerminalEvery?: number;
  /** Devuelve un id NUEVO por cada pedido, aunque la clave se repita (rompe la idempotencia). */
  breakIdempotency?: boolean;
  slowMs?: number;
}

function fakeEdge(fault: Fault = {}): Promise<{ server: Server; url: string; stats: { posts: number; created: number } }> {
  const byKey = new Map<string, string>();
  const stats = { posts: 0, created: 0 };
  let n = 0;
  const intents = new Map<string, { born: number; never: boolean }>();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'POST' && req.url === '/v1/payment_intents') {
      const finish = () => {
        stats.posts += 1;
        const key = String(req.headers['idempotency-key']);
        if (fault.rate429From !== undefined && stats.posts > fault.rate429From) return send(429, { code: 'rate_limited' });
        if (fault.fail5xxEvery && stats.posts % fault.fail5xxEvery === 0) return send(503, { code: 'ledger_unavailable' });
        let id = byKey.get(key);
        if (!id || fault.breakIdempotency) {
          n += 1;
          id = `pi_fake${String(n).padStart(8, '0')}`;
          byKey.set(key, id);
          stats.created += 1;
          intents.set(id, { born: Date.now(), never: Boolean(fault.neverTerminalEvery && n % fault.neverTerminalEvery === 0) });
        }
        send(201, { id, status: 'processing', amount_minor: 10000, fee_minor: 300, net_minor: 9700 });
      };
      req.resume();
      req.on('end', () => (fault.slowMs ? setTimeout(finish, fault.slowMs) : finish()));
      return;
    }
    const m = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      const found = intents.get(m[1]!);
      if (!found) return send(404, { code: 'resource_not_found' });
      return send(200, { id: m[1], status: found.never || Date.now() - found.born < 200 ? 'processing' : 'succeeded', net_minor: 9700 });
    }
    send(404, {});
  };
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stats }));
  });
}

const config = (url: string, patch: Partial<LoadConfig> = {}): LoadConfig => ({
  baseUrl: url,
  keys: ['sk_test_aaaa', 'sk_test_bbbb'],
  peakRps: 30,
  rampSeconds: 0.4,
  durationSeconds: 1.5,
  amounts: [10000],
  duplicateFraction: 0.3,
  requestTimeoutMs: 3000,
  settleTimeoutSeconds: 8,
  pollConcurrency: 10,
  maxInFlight: 500,
  runId: 'test',
  ...patch,
});
const cpuFake: CpuReport = { mode: 'none', samples: 0, perProcess: {}, machine: { busyAvg: 30, busyMax: 40, loadavgMax: 1, cores: 4 }, top: [] };

describe('runner de carga contra un borde falso', () => {
  let edge: Awaited<ReturnType<typeof fakeEdge>> | undefined;
  afterEach(async () => {
    if (edge) await new Promise((resolve) => edge!.server.close(resolve));
    edge = undefined;
  });

  it('CORRECTO: crea intentos con Idempotency-Key únicas, los repetidos devuelven el MISMO intento, todos llegan a terminal y el veredicto es consistente', async () => {
    edge = await fakeEdge();
    const result = await runLoad(config(edge.url));
    expect(result.sent).toBeGreaterThan(result.planned); // los repetidos suman pedidos
    expect(result.created).toBe(result.planned); // un intento por clave única
    expect(edge.stats.created).toBe(result.planned);
    expect(result.byStatus).toEqual({ '201': result.sent });
    expect(result.idempotencyViolations).toBe(0);
    expect(result.stuck).toBe(0);
    expect(result.terminalByStatus).toEqual({ succeeded: result.created });
    expect(result.succeeded).toHaveLength(result.created);
    expect(result.createLatencyMs.p99).not.toBeNull();
    const report = buildReport(result, cpuFake, { doubleEntries: 0, missingEntries: 0, amountMismatches: 0, checkedIntents: result.created, linesRead: result.created }, 4);
    expect(report.evaluation.verdict).toBe('APRUEBA');
    expect(exitCodeOf(report)).toBe(0);
    expect(renderReport(report)).toContain('VEREDICTO: APRUEBA');
    expect(renderReport(report)).toContain('NO representa el despliegue de producción');
  }, 30_000);

  it('el tiempo hasta el estado terminal se mide con el sondeo EN PARALELO al envío (no se infla con la duración de la fase de envío)', async () => {
    edge = await fakeEdge();
    const result = await runLoad(config(edge.url, { duplicateFraction: 0, peakRps: 10, rampSeconds: 0, durationSeconds: 4 }));
    expect(result.timeToTerminalMs.n).toBe(result.created);
    // El intento falso termina a los 200 ms y el sondeo pasa cada ~1 s: el p99 es del orden de 1,3 s. Si el sondeo esperara a que termine el envío (4 s), sería > 3 s.
    expect(result.timeToTerminalMs.p99!).toBeLessThan(2500);
  }, 30_000);

  it('LÍMITE: el 5xx inyectado se cuenta por código y rompe el criterio ⇒ NO APRUEBA', async () => {
    edge = await fakeEdge({ fail5xxEvery: 5 });
    const result = await runLoad(config(edge.url, { duplicateFraction: 0 }));
    expect(result.status5xx).toBeGreaterThan(0);
    expect(result.byErrorCode['503 ledger_unavailable']).toBe(result.status5xx);
    const report = buildReport(result, cpuFake, { doubleEntries: 0, missingEntries: 0, amountMismatches: 0, checkedIntents: 0, linesRead: 0 }, 4);
    expect(report.evaluation.verdict).toBe('NO_APRUEBA');
    expect(exitCodeOf(report)).toBe(1);
  }, 30_000);

  it('LÍMITE: los intentos que nunca llegan a terminal se detectan como colgados (plazo de espera corto)', async () => {
    edge = await fakeEdge({ neverTerminalEvery: 4 });
    const result = await runLoad(config(edge.url, { duplicateFraction: 0, settleTimeoutSeconds: 3 }));
    expect(result.stuck).toBeGreaterThan(0);
    expect(result.stuckSample.length).toBeGreaterThan(0);
    expect(result.stuck + Object.values(result.terminalByStatus).reduce((a, b) => a + b, 0)).toBe(result.created);
    expect(buildReport(result, cpuFake, null, 4).evaluation.verdict).toBe('NO_APRUEBA');
  }, 30_000);

  it('LÍMITE: una clave repetida que devuelve un intento DISTINTO (idempotencia rota) se detecta', async () => {
    edge = await fakeEdge({ breakIdempotency: true });
    const result = await runLoad(config(edge.url, { duplicateFraction: 1 }));
    expect(result.idempotencyViolations).toBeGreaterThan(0);
    expect(buildReport(result, cpuFake, { doubleEntries: 0, missingEntries: 0, amountMismatches: 0, checkedIntents: 0, linesRead: 0 }, 4).evaluation.verdict).toBe('NO_APRUEBA');
  }, 30_000);

  it('LÍMITE: los 429 se cuentan aparte (no son 5xx) y el resultado queda NO CONCLUYENTE: parte de la carga no llegó', async () => {
    edge = await fakeEdge({ rate429From: 10 });
    const result = await runLoad(config(edge.url, { duplicateFraction: 0 }));
    expect(result.status429).toBeGreaterThan(0);
    expect(result.status5xx).toBe(0);
    const report = buildReport(result, cpuFake, { doubleEntries: 0, missingEntries: 0, amountMismatches: 0, checkedIntents: 0, linesRead: 0 }, 4);
    expect(report.evaluation.verdict).toBe('NO_CONCLUYENTE');
    expect(exitCodeOf(report)).toBe(3);
  }, 30_000);

  it('LÍMITE: un plazo de petición vencido es AMBIGUO (sin respuesta), no un 5xx', async () => {
    edge = await fakeEdge({ slowMs: 600 });
    const result = await runLoad(config(edge.url, { duplicateFraction: 0, requestTimeoutMs: 150, settleTimeoutSeconds: 1, peakRps: 10, durationSeconds: 1, rampSeconds: 0 }));
    expect(result.noResponse).toBeGreaterThan(0);
    expect(result.status5xx).toBe(0);
  }, 30_000);

  it('INVÁLIDO: sin claves, o con una clave live, el runner se niega ANTES de enviar nada', async () => {
    edge = await fakeEdge();
    await expect(runLoad(config(edge.url, { keys: [] }))).rejects.toThrow(/al menos una clave/);
    await expect(runLoad(config(edge.url, { keys: ['sk_live_zzzz'] }))).rejects.toThrow(/sk_test_/);
    expect(edge.stats.posts).toBe(0);
  });

  it('INVÁLIDO: un destino que no responde ⇒ todo ambiguo, sin lanzar y sin intentos creados', async () => {
    const result = await runLoad(config('http://127.0.0.1:1', { duplicateFraction: 0, requestTimeoutMs: 500, settleTimeoutSeconds: 1, peakRps: 5, durationSeconds: 1, rampSeconds: 0 }));
    expect(result.answered).toBe(0);
    expect(result.noResponse).toBe(result.sent);
    expect(result.created).toBe(0);
    expect(buildReport(result, cpuFake, null, 4).evaluation.verdict).toBe('NO_CONCLUYENTE');
  });
});

describe('lectura paginada del ledger', () => {
  it('lee todas las páginas por cursor y trata 404 como «sin asientos»', async () => {
    const pages = [
      { data: [{ business_ref: 'pi_a:capture', direction: 'credit', amount_minor: 1 }], has_more: true, next_cursor: 'c1' },
      { data: [{ business_ref: 'pi_b:capture', direction: 'credit', amount_minor: 1 }], has_more: false, next_cursor: null },
    ];
    const seen: string[] = [];
    const fetchFake = (async (url: string) => {
      seen.push(url);
      if (url.includes('mc_nada')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(url.includes('starting_after=c1') ? pages[1] : pages[0]), { status: 200 });
    }) as unknown as typeof fetch;
    const lines = await readPending({ baseUrl: 'http://ledger', from: '2026-10-28T00:00:00.000Z' }, 'mc_1', fetchFake);
    expect(lines.map((l) => l.business_ref)).toEqual(['pi_a:capture', 'pi_b:capture']);
    expect(seen[0]).toContain('account=merchant%3Amc_1%3Apending');
    expect(seen[0]).toContain('from=2026-10-28T00%3A00%3A00.000Z');
    expect(await readPending({ baseUrl: 'http://ledger', from: 'x' }, 'mc_nada', fetchFake)).toEqual([]);
  });
  it('un error del ledger NO se lee como «sin asientos»: lanza', async () => {
    const fetchFake = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(readPending({ baseUrl: 'http://ledger', from: 'x' }, 'mc_1', fetchFake)).rejects.toThrow(/503/);
  });
});
