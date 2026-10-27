import { createServer, type Server } from 'node:http';
import { runCli, type CliIo } from '../src/cli-main';

// CLI `mockbank pay <qr>` (P4.H4.M4). Contra un servidor HTTP de verdad que hace de pay-mockbank.
let server: Server;
let reply: { status: number; body: string } = { status: 200, body: '{}' };
let seen: { method?: string; url?: string; headers?: Record<string, unknown>; body?: string } = {};
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = async (argv: string[], env: Record<string, string | undefined> = { MOCKBANK_URL: base }) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, fetchImpl: fetch, out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
};

describe('mockbank pay <qr>', () => {
  it('correcto: manda el QR al endpoint del pagador con la identidad pay-mockbank, imprime el resultado y sale con 0', async () => {
    reply = { status: 200, body: '{"charge_reference":"ch_abc","status":"captured","amount_minor":10000,"already_paid":false}' };
    const result = await run(['pay', '000201...6304ABCD']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ status: 'captured' });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/sandbox/payer/pay');
    expect(seen.headers?.['x-service-id']).toBe('pay-mockbank');
    expect(JSON.parse(seen.body ?? '')).toEqual({ qr_payload: '000201...6304ABCD' });
  });

  it('transfer: manda referencia e importe al depósito del pagador; el importe tiene que ser un entero positivo de centavos', async () => {
    reply = { status: 200, body: '{"bank_reference":"SIM-X-000001","reference":"TRABCDEFGHIJ","amount_minor":20000,"account":"transfers"}' };
    const ok = await run(['transfer', 'TRABCDEFGHIJ', '20000']);
    expect(ok.code).toBe(0);
    expect(seen.url).toBe('/sandbox/payer/transfer-in');
    expect(JSON.parse(seen.body ?? '')).toEqual({ reference: 'TRABCDEFGHIJ', amount_minor: 20000 });
    for (const bad of [['transfer'], ['transfer', 'TR1'], ['transfer', 'TR1', '0'], ['transfer', 'TR1', '-5'], ['transfer', 'TR1', '10.5'], ['transfer', 'TR1', '1e3'], ['transfer', 'TR1', '100', 'extra']]) {
      const result = await run(bad);
      expect(result.code).toBe(2);
    }
  });

  it('límite: MOCKBANK_URL con barra final funciona', async () => {
    reply = { status: 200, body: '{}' };
    expect((await run(['pay', 'x'.repeat(30)], { MOCKBANK_URL: `${base}/` })).code).toBe(0);
    expect(seen.url).toBe('/sandbox/payer/pay');
  });

  it('inválido: sin argumentos, comando desconocido o argumentos de más ⇒ uso y código 2', async () => {
    for (const argv of [[], ['pay'], ['refund', 'x'], ['pay', 'a', 'b']]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.err).toContain('uso: mockbank pay');
    }
  });

  it('inválido: el servidor rechaza (422 / 404 / 500 con HTML) ⇒ código 1 y SOLO el código del problema (no se repite el cuerpo crudo)', async () => {
    reply = { status: 422, body: '{"code":"validation_failed","errors":[{"field":"qr_payload","code":"crc_invalid"}],"detail":"secreto-que-no-debe-salir"}' };
    const invalid = await run(['pay', 'qr-con-crc-malo-0123456789']);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('HTTP 422 validation_failed (crc_invalid)');
    expect(invalid.err).not.toContain('secreto-que-no-debe-salir');
    reply = { status: 500, body: '<html>boom</html>' };
    const html = await run(['pay', 'qr-con-crc-malo-0123456789']);
    expect(html.code).toBe(1);
    expect(html.err).toContain('HTTP 500 error');
  });

  it('inválido: pay-mockbank apagado ⇒ código 1 con mensaje claro', async () => {
    const result = await run(['pay', 'qr-con-crc-malo-0123456789'], { MOCKBANK_URL: 'http://127.0.0.1:1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('no se pudo conectar');
  });
});
