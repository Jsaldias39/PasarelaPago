import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BankFaultProxy } from './fault-proxy.ts';

/**
 * El proxy de fallos es un doble del arnés (ver fault-proxy.ts); estas pruebas no levantan ningún stack: un «banco» HTTP local cuenta lo que recibe.
 * Tres niveles: correcto (reenvía fiel), límite (corta SOLO la orden marcada y DESPUÉS de que el banco la ejecutó) e inválido (sin destino o con el banco
 * caído no inventa ninguna respuesta de banco).
 */
/** El «banco» de la prueba devuelve lo que recibió si es JSON; si no lo es, `null` (no se cae: lo que se prueba es el proxy, no el banco). */
const echo = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
};

describe('BankFaultProxy', () => {
  let bank: Server;
  let bankUrl: string;
  const received: { method: string; url: string; body: string; serviceId: string | undefined }[] = [];
  let proxy: BankFaultProxy;

  beforeAll(async () => {
    bank = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), serviceId: req.headers['x-service-id'] as string | undefined });
        if (req.url === '/sandbox/down') {
          res.writeHead(503, { 'content-type': 'application/problem+json' });
          res.end(JSON.stringify({ code: 'bank_unavailable' }));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json', 'x-pay-mode': 'sandbox' });
        res.end(JSON.stringify({ ok: true, echoed: echo(Buffer.concat(chunks).toString('utf8')) }));
      });
    });
    await new Promise<void>((resolve) => bank.listen(0, '127.0.0.1', resolve));
    bankUrl = `http://127.0.0.1:${(bank.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    bank.closeAllConnections();
    await new Promise<void>((resolve) => bank.close(() => resolve()));
  });
  beforeEach(async () => {
    received.length = 0;
    proxy = new BankFaultProxy();
    await proxy.listen();
    proxy.setTarget(bankUrl);
  });
  afterEach(async () => {
    await proxy.close();
  });

  const post = (path: string, json: unknown) => fetch(`${proxy.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-id': 'pay-connectors' }, body: JSON.stringify(json) });

  it('CORRECTO: en modo pass reenvía método, ruta, cuerpo y cabeceras, y devuelve estado, cabeceras y cuerpo del banco', async () => {
    const res = await post('/sandbox/refunds', { reference: 'cr_aaaaaaaaaaaa', amount_minor: 4000 });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-pay-mode')).toBe('sandbox');
    expect(await res.json()).toEqual({ ok: true, echoed: { reference: 'cr_aaaaaaaaaaaa', amount_minor: 4000 } });
    expect(received).toEqual([{ method: 'POST', url: '/sandbox/refunds', body: JSON.stringify({ reference: 'cr_aaaaaaaaaaaa', amount_minor: 4000 }), serviceId: 'pay-connectors' }]);
    expect(proxy.records).toEqual([{ method: 'POST', path: '/sandbox/refunds', reference: 'cr_aaaaaaaaaaaa', upstreamStatus: 201, action: 'forwarded' }]);
  });

  it('CORRECTO: devuelve tal cual una negativa DEFINITIVA del banco (503 con su cuerpo), sin convertirla en otra cosa', async () => {
    const res = await post('/sandbox/down', { reference: 'x' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'bank_unavailable' });
  });

  it('LÍMITE: en modo cut_after_execute el banco RECIBE y ejecuta la orden marcada, y el cliente no recibe respuesta (conexión cortada)', async () => {
    proxy.mode = 'cut_after_execute';
    await expect(post('/sandbox/refunds', { reference: 'cr_bbbbbbbbbbbb', amount_minor: 1 })).rejects.toThrow();
    expect(received.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /sandbox/refunds']); // el banco SÍ la vio
    expect(proxy.records).toEqual([{ method: 'POST', path: '/sandbox/refunds', reference: 'cr_bbbbbbbbbbbb', upstreamStatus: 201, action: 'cut' }]);
  });

  it('LÍMITE: el corte es solo de la orden marcada; el resto (otra ruta, otro método) pasa aunque el modo sea de corte', async () => {
    proxy.mode = 'cut_after_execute';
    const other = await post('/sandbox/charges', { reference: 'ch_1' });
    expect(other.status).toBe(201);
    const probe = await fetch(`${proxy.url}/sandbox/probe`, { headers: { 'x-service-id': 'pay-connectors' } });
    expect(probe.status).toBe(201);
    expect(proxy.records.map((r) => r.action)).toEqual(['forwarded', 'forwarded']);
  });

  it('LÍMITE: volver a pass después de cortar deja pasar el reintento con la MISMA referencia (el registro lo demuestra)', async () => {
    proxy.mode = 'cut_after_execute';
    await expect(post('/sandbox/refunds', { reference: 'cr_cccccccccccc', amount_minor: 5 })).rejects.toThrow();
    proxy.mode = 'pass';
    expect((await post('/sandbox/refunds', { reference: 'cr_cccccccccccc', amount_minor: 5 })).status).toBe(201);
    const seen = proxy.recordsOf('POST', '/sandbox/refunds');
    expect(seen.map((r) => [r.reference, r.action])).toEqual([['cr_cccccccccccc', 'cut'], ['cr_cccccccccccc', 'forwarded']]);
  });

  it('INVÁLIDO: sin destino configurado corta la conexión y el banco no recibe nada', async () => {
    proxy.setTarget(undefined);
    await expect(post('/sandbox/refunds', { reference: 'cr_dddddddddddd' })).rejects.toThrow();
    expect(received).toEqual([]);
    expect(proxy.records).toEqual([{ method: 'POST', path: '/sandbox/refunds', reference: 'cr_dddddddddddd', upstreamStatus: null, action: 'refused' }]);
  });

  it('INVÁLIDO: con el banco inalcanzable no inventa una respuesta de banco: corta, y lo registra como refused', async () => {
    proxy.setTarget('http://127.0.0.1:1');
    await expect(post('/sandbox/refunds', { reference: 'cr_eeeeeeeeeeee' })).rejects.toThrow();
    expect(proxy.records.map((r) => r.action)).toEqual(['refused']);
  });

  it('INVÁLIDO: un cuerpo que no es JSON o no trae reference se registra con reference null y se reenvía igual', async () => {
    const res = await fetch(`${proxy.url}/sandbox/charges`, { method: 'POST', headers: { 'x-service-id': 'pay-connectors' }, body: 'no es json' });
    expect(res.status).toBe(201);
    expect(proxy.records[0]?.reference).toBeNull();
  });
});
