import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { CONNECTORS, MC, MC2, PAYMENTS, captureOutput, startVault, type VaultTest } from './helpers/app';

let v: VaultTest;
beforeAll(async () => {
  v = await startVault();
});
afterAll(async () => v.close());

const SECRETS = ['4111111111111111', '4111 1111 1111 1111', '5555555555554444', 'TITULAR SENTINELA', '7391'];
const http = () => request(v.app.getHttpServer());
let n = 0;
const k = () => `k-leak-${randomBytes(4).toString('hex')}-${n++}`;

/** Texto de TODAS las tablas del esquema de la prueba: si una columna guardara el PAN, aparecería acá. */
async function dumpDatabase(): Promise<string> {
  const tables = await v.db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
  const parts: string[] = [];
  for (const { table_name } of tables.rows) parts.push(JSON.stringify((await v.db.pool.query(`SELECT row_to_json(t) FROM "${table_name}" t`)).rows));
  return parts.join('\n');
}

describe('P3.H3.M3 · grep del PAN de prueba: bases, logs y respuestas fuera de `reveal` → 0 apariciones', () => {
  it('el número, el CVV y el titular no aparecen en ninguna tabla, ningún log ni ninguna respuesta (salvo el reveal, que es su función)', async () => {
    const responses: string[] = [];
    const record = (r: request.Response) => {
      responses.push(JSON.stringify(r.body), JSON.stringify(r.headers));
      return r;
    };
    const { output } = await captureOutput(async () => {
      const tokens: string[] = [];
      for (const [merchant, card] of [[MC, { number: '4111111111111111', expMonth: 12, expYear: 2031, cvv: '7391', holderName: 'TITULAR SENTINELA' }], [MC2, { number: '5555555555554444', expMonth: 6, expYear: 2029, cvv: '7391', holderName: 'TITULAR SENTINELA' }]] as const) {
        const session = record(await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', k()).send({ merchant_id: merchant, expires_in_seconds: 600, save_card: true }));
        v.backend.completeCapture(session.body.id, card);
        const done = record(await http().get(`/capture_sessions/${session.body.id}`).set(PAYMENTS));
        tokens.push(done.body.token);
        record(await http().get(`/tokens/${done.body.token}`).set(PAYMENTS).set('x-merchant-id', merchant));
      }
      const [t1] = tokens as [string, string];
      // Caminos de error con el PAN en la entrada: cuerpos inválidos, token ajeno, servicio no permitido, backend caído.
      record(await http().post(`/tokens/${t1}/reveal`).set(CONNECTORS).set('x-merchant-id', MC).set('idempotency-key', k()).send({ charge_id: '4111111111111111' }));
      record(await http().post(`/tokens/${t1}/reveal`).set(PAYMENTS).set('x-merchant-id', MC).set('idempotency-key', k()).send({ charge_id: 'ch_aaaaaaaaaaaa' }));
      record(await http().post(`/tokens/${t1}/reveal`).set(CONNECTORS).set('x-merchant-id', MC2).set('idempotency-key', k()).send({ charge_id: 'ch_aaaaaaaaaaaa' }));
      record(await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', k()).send({ merchant_id: MC, expires_in_seconds: 600, pan: '4111111111111111' }));
      record(await http().get('/tokens/4111111111111111').set(PAYMENTS).set('x-merchant-id', MC));
      v.backend.failNext = 1;
      record(await http().post(`/tokens/${t1}/reveal`).set(CONNECTORS).set('x-merchant-id', MC).set('idempotency-key', k()).send({ charge_id: 'ch_aaaaaaaaaaaa' }));
      // Control positivo: el reveal SÍ devuelve el dato; si el grep no lo viera acá, no probaría nada en los demás lados.
      const revealed = await http().post(`/tokens/${t1}/reveal`).set(CONNECTORS).set('x-merchant-id', MC).set('idempotency-key', k()).send({ charge_id: 'ch_aaaaaaaaaaab' });
      expect(JSON.stringify(revealed.body)).toContain('4111111111111111');
      await http().delete(`/tokens/${t1}`).set(PAYMENTS).set('x-merchant-id', MC);
    });

    const database = await dumpDatabase();
    const hits = (haystack: string) => SECRETS.filter((s) => haystack.includes(s));
    expect({ donde: 'tablas', hits: hits(database) }).toEqual({ donde: 'tablas', hits: [] });
    expect({ donde: 'logs', hits: hits(output) }).toEqual({ donde: 'logs', hits: [] });
    expect({ donde: 'respuestas', hits: hits(responses.join('\n')) }).toEqual({ donde: 'respuestas', hits: [] });
    // El volcado no está vacío (el grep miró algo de verdad).
    expect(database.length).toBeGreaterThan(500);
    expect(database).toContain('1111');
  });
});
