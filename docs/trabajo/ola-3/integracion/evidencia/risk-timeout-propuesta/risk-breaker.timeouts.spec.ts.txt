import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CircuitBreaker, HttpClient, UpstreamError } from '../src/clients/http';
import { RiskClient } from '../src/clients/risk.client';

/**
 * Reproductor `risk-timeout` (P3/P5): un timeout del cliente sobre una evaluación de riesgo idempotente que SIGUE en curso no es una falla de la
 * dependencia (CLAUDE.md regla 11). Si el breaker la cuenta, N cobros simultáneos abren el breaker con sus propios timeouts, las actividades gastan sus
 * reintentos contra `circuit_open` (nunca llegan a riesgo) y, al volver, el semiabierto deja pasar UNA sola llamada: el resto cierra `failed/risk_unavailable`.
 */
const timeout = () => new UpstreamError('timeout', 'pay-risk');

describe('breaker con ignoreTimeouts (cliente de riesgo)', () => {
  it('correcto · un timeout no cuenta: 50 seguidos no abren el breaker', async () => {
    const breaker = new CircuitBreaker('pay-risk', { failureThreshold: 5, resetAfterMs: 10_000, ignoreTimeouts: true });
    for (let i = 0; i < 50; i += 1) await expect(breaker.exec(async () => { throw timeout(); })).rejects.toMatchObject({ kind: 'timeout' });
    expect(breaker.state).toBe('closed');
  });

  it('límite · los timeouts no reinician la cuenta ni la inflan: 4 fallas reales + 100 timeouts no abren; la 5.ª falla real abre', async () => {
    const breaker = new CircuitBreaker('pay-risk', { failureThreshold: 5, resetAfterMs: 10_000, ignoreTimeouts: true });
    const real = () => breaker.exec(async () => { throw new UpstreamError('server_error', 'pay-risk', 503); });
    for (let i = 0; i < 4; i += 1) await expect(real()).rejects.toMatchObject({ kind: 'server_error' });
    for (let i = 0; i < 100; i += 1) await expect(breaker.exec(async () => { throw timeout(); })).rejects.toMatchObject({ kind: 'timeout' });
    expect(breaker.state).toBe('closed');
    await expect(real()).rejects.toBeDefined();
    expect(breaker.state).toBe('open');
  });

  it('inválido/control · red y 5xx SIGUEN abriendo el breaker (riesgo caído de verdad), y sin la opción un timeout cuenta como siempre', async () => {
    const down = new CircuitBreaker('pay-risk', { failureThreshold: 2, resetAfterMs: 10_000, ignoreTimeouts: true });
    await expect(down.exec(async () => { throw new UpstreamError('network', 'pay-risk'); })).rejects.toBeDefined();
    await expect(down.exec(async () => { throw new UpstreamError('server_error', 'pay-risk', 500); })).rejects.toBeDefined();
    expect(down.state).toBe('open');
    await expect(down.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' });

    const legacy = new CircuitBreaker('pay-connectors', { failureThreshold: 2, resetAfterMs: 10_000 });
    for (let i = 0; i < 2; i += 1) await expect(legacy.exec(async () => { throw timeout(); })).rejects.toBeDefined();
    expect(legacy.state).toBe('open');
  });
});

describe('cliente de riesgo REAL contra un servidor cargado y con clave idempotente (4 cobros simultáneos, timeout 40 ms < evaluación 150 ms y < 409 de 60 ms)', () => {
  it('con ignoreTimeouts el breaker sigue cerrado y la 2.ª vuelta recibe la respuesta guardada; sin él, el breaker se abre y la 2.ª vuelta ni sale (circuit_open)', async () => {
    const startedAt = new Map<string, number>();
    const server = createServer((req, res) => {
      req.resume();
      const key = String(req.headers['idempotency-key']);
      const first = !startedAt.has(key);
      if (first) startedAt.set(key, Date.now());
      const finished = Date.now() - (startedAt.get(key) as number) >= 150;
      const stored = { id: 'ra_x', decision: 'allow', reason_code: 'ok', rule_version: 1, screened: true };
      // Evaluación en curso: la 1.ª llamada responde al terminar (150 ms); un reintento recibe el 409 «en curso», pero con riesgo cargado tarda 60 ms (> 40).
      if (first) setTimeout(() => res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(stored)), 150);
      else if (!finished) setTimeout(() => res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'idempotency_request_in_progress' })), 60);
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stored));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const drive = async (ignoreTimeouts: boolean) => {
      startedAt.clear();
      const http = new HttpClient({ name: 'pay-risk', baseUrl, serviceId: 'pay-payments', timeoutMs: 40, retries: 1, breaker: { failureThreshold: 5, resetAfterMs: 10_000, ...(ignoreTimeouts ? { ignoreTimeouts: true } : {}) } });
      const risk = new RiskClient(http);
      const call = (n: number) => risk.assess({ merchantId: 'mc_aaaaaaaaaaaa', paymentIntentId: `pi_${'a'.repeat(10)}${n}`, amountMinor: 10_000, currency: 'BOB', method: 'qr' }).catch((e: unknown) => e as Error);
      await Promise.all([1, 2, 3, 4].map(call)); // 1.ª vuelta de la actividad: 4 timeouts a los 40 ms y el reintento interno (409 lento) también vence
      await new Promise((r) => setTimeout(r, 250)); // la evaluación ya terminó en el servidor
      const second = await Promise.all([1, 2, 3, 4].map(call)); // 2.ª vuelta, misma clave
      return { state: http.breaker.state, second };
    };
    try {
      const fixed = await drive(true);
      expect(fixed.state).toBe('closed');
      expect(fixed.second.map((r) => (r as { decision?: string }).decision)).toEqual(['allow', 'allow', 'allow', 'allow']);
      const legacy = await drive(false);
      expect(legacy.state).toBe('open'); // control negativo: el defecto
      expect(legacy.second.map((r) => (r as UpstreamError).kind)).toEqual(['circuit_open', 'circuit_open', 'circuit_open', 'circuit_open']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
