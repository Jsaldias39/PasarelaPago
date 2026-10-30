import { gzipSync } from 'node:zlib';
import { OtlpSink } from './otlp-sink.ts';

/** El colector de trazas del arnés (otlp-sink.ts): correcto (guarda el cuerpo tal cual, también el comprimido), límite (varios envíos, binario con bytes no ASCII) e inválido (otra ruta, otro método, gzip corrupto). */
describe('OtlpSink', () => {
  let sink: OtlpSink;
  beforeEach(async () => {
    sink = new OtlpSink();
    await sink.listen();
  });
  afterEach(async () => {
    await sink.close();
  });

  const post = (path: string, body: Buffer | string, headers: Record<string, string> = {}) => fetch(`${sink.endpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf', ...headers }, body: typeof body === 'string' ? body : new Uint8Array(body) });

  it('CORRECTO: guarda el cuerpo de POST /v1/traces tal cual y responde 200 vacío; text() y mentions() lo encuentran', async () => {
    const payload = Buffer.concat([Buffer.from([0x0a, 0x10]), Buffer.from('service.name pay-edge /v1/payment_intents', 'latin1'), Buffer.from([0xff, 0x00, 0xfe])]);
    const res = await post('/v1/traces', payload);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(sink.bodies).toHaveLength(1);
    expect(sink.bodies[0]!.body.equals(payload)).toBe(true);
    expect(sink.bodies[0]!.contentType).toBe('application/x-protobuf');
    expect(sink.mentions('pay-edge')).toBe(true);
    expect(sink.text()).toContain('/v1/payment_intents');
  });

  it('CORRECTO: descomprime gzip antes de guardar', async () => {
    await post('/v1/traces', gzipSync(Buffer.from('span con pay-vault')), { 'content-encoding': 'gzip' });
    expect(sink.mentions('pay-vault')).toBe(true);
  });

  it('LÍMITE: acumula varios envíos en orden y mentions() distingue lo que no está', async () => {
    await post('/v1/traces', 'uno');
    await post('/v1/traces', 'dos');
    expect(sink.bodies.map((b) => b.body.toString())).toEqual(['uno', 'dos']);
    expect(sink.mentions('tres')).toBe(false);
  });

  it('INVÁLIDO: otra ruta (404), otro método (405) y un gzip corrupto (400) no se guardan', async () => {
    expect((await post('/v1/metrics', 'x')).status).toBe(404);
    expect((await fetch(`${sink.endpoint}/v1/traces`)).status).toBe(405);
    expect((await post('/v1/traces', Buffer.from('no es gzip'), { 'content-encoding': 'gzip' })).status).toBe(400);
    expect(sink.bodies).toEqual([]);
  });
});
