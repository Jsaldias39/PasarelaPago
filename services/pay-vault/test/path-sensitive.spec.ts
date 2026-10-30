import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { jest } from '@jest/globals';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { safeUrl } from '../src/log-safe';
import { MaskingTraceExporter } from '../src/observability/masking-exporter';

/**
 * Tanda 3c · segmentos de ruta con forma de PAN, NIT o cédula (CI) no llegan a logs, `instance` ni spans (hallado por P5 en pay-merchants).
 * Datos SINTÉTICOS: ningún número de abajo es de una persona ni de una tarjeta real (4111…1111 es el PAN de prueba público).
 */
const PAN = '4111111111111111';
const NIT = '1023456028';
const NIT_CORTO = '1234567';
const CI = '1234567';
const CI_COMPLEMENTO = '7654321-1A';
const LEAKS = [PAN, NIT, CI, '7654321', '1A', '4111'];
const ROUTE_A = '/tokens';
const ROUTE_B = '/capture_sessions';
const AUTH = { 'x-service-id': 'pay-payments', 'x-merchant-id': 'mc_merchant00001' };
const root = process.cwd();

describe('safeUrl (tres niveles)', () => {
  it.each([
    ['correcto', `${ROUTE_A}/tok_abcdefghij12`, `${ROUTE_A}/tok_abcdefghij12`],
    ['correcto', '/health/ready', '/health/ready'],
    ['correcto', '/probe/problem', '/probe/problem'],
    ['correcto (plantilla de ruta de Express)', `${ROUTE_A}/:id`, `${ROUTE_A}/:id`],
  ])('%s · %s se conserva', (_nivel, input, expected) => expect(safeUrl(input)).toBe(expected));

  it.each([
    ['PAN con Luhn', `${ROUTE_A}/${PAN}`],
    ['PAN con espacios', `${ROUTE_A}/4111 1111 1111 1111`],
    ['NIT de 10 dígitos', `${ROUTE_A}/${NIT}`],
    ['NIT de 7 dígitos', `${ROUTE_A}/${NIT_CORTO}`],
    ['NIT de 13 dígitos', `${ROUTE_A}/1023456028019`],
    ['CI de 7 dígitos', `${ROUTE_B}/${CI}`],
    ['CI con complemento', `${ROUTE_B}/${CI_COMPLEMENTO}`],
    ['CI de 5 dígitos', `${ROUTE_B}/12345`],
    ['con etiqueta nit_', `${ROUTE_A}/nit_${NIT}`],
    ['con etiqueta ci_', `${ROUTE_A}/ci_${CI}`],
    ['con etiqueta y guion', `${ROUTE_A}/NIT-${NIT}`],
    ['id propio solo con dígitos', `${ROUTE_A}/pi_${NIT}`],
    ['PAN pegado a un id propio', `${ROUTE_A}/pi_a${PAN}`],
    ['espacio codificado', `${ROUTE_B}/7654321%201A`],
  ])('límite · %s se enmascara', (_caso, input) => {
    const out = safeUrl(input);
    expect(out).toMatch(/\/:x$/);
    for (const leak of LEAKS) expect(out).not.toContain(leak);
  });

  it.each([
    ['la query nunca se conserva', `${ROUTE_A}/tok_abcdefghij12?nit=${NIT}&ci=${CI}`, `${ROUTE_A}/tok_abcdefghij12`],
    ['cadena vacía', '', ''],
    ['solo la raíz', '/', '/'],
    ['barras repetidas', `//${NIT}//`, '//:x//'],
    ['segmento muy largo', `/${'a1'.repeat(500)}`, '/:x'],
    ['unicode y puntos', `/${NIT}/..%2f${CI}/ñandú/.`, '/:x/:x/:x/:x'],
    ['mayúsculas (no es una palabra de ruta)', `${ROUTE_A}/JUAN`, `${ROUTE_A}/:x`],
  ])('inválido · %s', (_caso, input, expected) => expect(safeUrl(input)).toBe(expected));
});

describe('los atributos de URL de los spans se enmascaran antes de exportar (MaskingTraceExporter)', () => {
  it('enmascara url.path, url.full, http.target, http.url y http.route; no toca el resto', () => {
    const seen: Record<string, unknown>[] = [];
    const spy = jest.spyOn(OTLPTraceExporter.prototype, 'export').mockImplementation(function (this: unknown, spans: { attributes: Record<string, unknown> }[], done: (r: { code: number }) => void) {
      for (const s of spans) seen.push({ ...s.attributes });
      done({ code: 0 });
    } as never);
    try {
      const exporter = new MaskingTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' });
      const span = { attributes: { 'url.path': `${ROUTE_A}/${NIT}`, 'url.full': `http://svc:3000${ROUTE_B}/${CI_COMPLEMENTO}?x=${PAN}`, 'http.target': `${ROUTE_A}/${PAN}`, 'http.url': `http://svc/${NIT}`, 'http.route': `${ROUTE_A}/:id`, 'url.query': `documento=${NIT}`, 'http.method': 'GET', 'db.system': 'postgresql' } };
      exporter.export([span] as never, () => undefined);
      expect(seen).toHaveLength(1);
      const text = JSON.stringify(seen[0]);
      for (const leak of LEAKS) expect(text).not.toContain(leak);
      expect(seen[0]).toMatchObject({ 'url.path': `${ROUTE_A}/:x`, 'url.full': `http://svc:3000${ROUTE_B}/:x`, 'http.method': 'GET', 'db.system': 'postgresql', 'http.route': `${ROUTE_A}/:id`, 'url.query': '[redacted]' });
    } finally {
      spy.mockRestore();
    }
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe('el servicio real (dist/main.js): PAN, NIT y CI en la ruta no llegan al log de acceso, a `instance` ni a los spans que salen por OTLP', () => {
  it('peticiones con PAN, NIT y CI en la ruta, con y sin identidad de servicio', async () => {
    const received: Buffer[] = [];
    const collector: Server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const otlp = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(root, 'dist/main.js')], {
      env: { ...process.env, PORT: String(port), CONSUME_EVENTS: 'false', TEMPORAL_RUN_WORKER: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: otlp, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const get = async (url: string, headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
      return { status: response.status, text: await response.text() };
    };
    try {
      const deadline = Date.now() + 60_000;
      while ((await get('/health/live', {}).catch(() => ({ status: 0 }))).status !== 200) {
        if (Date.now() > deadline) throw new Error('la API no arrancó');
        await sleep(100);
      }
      const urls = [`${ROUTE_A}/${NIT}`, `${ROUTE_A}/${PAN}`, `${ROUTE_B}/${CI_COMPLEMENTO}`, `${ROUTE_B}/${CI}`, `${ROUTE_A}/nit_${NIT}?documento=${NIT}`];
      const bodies: string[] = [];
      for (const url of urls) {
        for (const headers of [{}, AUTH]) {
          const r = await get(url, headers);
          expect(r.status).toBeGreaterThanOrEqual(400);
          expect(r.status).toBeLessThan(500);
          bodies.push(r.text);
          expect(JSON.parse(r.text).instance).toMatch(/\/:x$/);
        }
      }
      // 1 · `instance` y cuerpo de los errores: ni PAN, ni NIT, ni CI.
      for (const leak of LEAKS) expect(bodies.join('\n')).not.toContain(leak);
      // 2 · log de acceso: la ruta aparece enmascarada y nada más.
      await sleep(500);
      expect(output).toContain(':x');
      for (const leak of LEAKS) expect(output).not.toContain(leak);
      // 3 · spans: el exportador manda los atributos de URL ya enmascarados. Se espera al lote (5 s por defecto) y se busca en los bytes crudos.
      const spanDeadline = Date.now() + 30_000;
      while (!received.some((b) => b.includes(Buffer.from(ROUTE_A.slice(1)))) && Date.now() < spanDeadline) await sleep(250);
      const wire = Buffer.concat(received);
      expect(wire.includes(Buffer.from(ROUTE_A.slice(1)))).toBe(true); // llegaron spans con la ruta (control: la sonda no está ciega)
      expect(wire.includes(Buffer.from(':x'))).toBe(true);
      for (const leak of LEAKS.filter((l) => l.length >= 5)) expect(wire.includes(Buffer.from(leak))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL'); // por PID: nunca por nombre
      await exited;
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  });
});
