import request from 'supertest';
import { PAYMENTS, startVault, type VaultTest } from './helpers/app';

/**
 * Tanda 3c · Postgres corta la conexión PRESTADA en medio de una transacción de pay-vault (`pg_terminate_backend`). Con el servicio real
 * (`VaultService`, controlador, filtro de errores) sobre una base real y el pool de `createPgPool`. Se exige: proceso vivo (sin `guardPool` el
 * evento `error` del cliente prestado tumbaría este worker de Jest), el error del contrato (500 problem+json sin mensaje ni SQL), NADA a medias
 * y que reintentar con la misma `Idempotency-Key` converja en UNA sola sesión de captura (un corte no es un «no existe»).
 */
let v: VaultTest;
beforeAll(async () => {
  v = await startVault();
});
afterAll(async () => v.close());

const sleeping = async (prefix: string): Promise<number | undefined> =>
  (await v.db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event = 'PgSleep' AND query ILIKE $1 AND pid <> pg_backend_pid()", [`${prefix}%`])).rows[0]?.pid;
async function until<T>(probe: () => Promise<T | undefined>, ms: number, label: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Se agotó la espera de: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}
const sessions = async (): Promise<number> => (await v.db.pool.query('SELECT count(*)::int AS n FROM capture_sessions')).rows[0].n;

describe('corte a mitad de una transacción (conexión prestada) en pay-vault', () => {
  it('abrir una sesión de captura: se corta DENTRO de la transacción atómica ⇒ 500 internal_error sin mensaje, NADA a medias y reintentar con la MISMA clave crea UNA sesión', async () => {
    const before = await sessions();
    const idempotencyKey = `k-vault-3c-${Date.now()}`;
    const body = { merchant_id: 'mc_merchant00001', expires_in_seconds: 600, save_card: false };
    await v.db.pool.query(`CREATE FUNCTION test_slow_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
    await v.db.pool.query('CREATE TRIGGER test_slow_capture BEFORE INSERT ON capture_sessions FOR EACH ROW EXECUTE FUNCTION test_slow_capture()');
    try {
      const pending = request(v.app.getHttpServer()).post('/capture_sessions').set(PAYMENTS).set('idempotency-key', idempotencyKey).send(body).then((r) => r);
      const victim = await until(() => sleeping('INSERT INTO capture_sessions'), 15_000, 'la transacción en curso');
      expect((await v.db.pool.query('SELECT pg_terminate_backend($1) AS done', [victim])).rows[0].done).toBe(true);
      const response = await pending;
      expect(response.status).toBe(500);
      expect(response.type).toBe('application/problem+json');
      expect(response.body.code).toBe('internal_error');
      expect(JSON.stringify(response.body)).not.toMatch(/terminat|administrator|INSERT|SELECT|57P01/i);
    } finally {
      await v.db.pool.query('DROP TRIGGER IF EXISTS test_slow_capture ON capture_sessions');
    }
    expect(await sessions()).toBe(before); // nada a medias
    const retry = await request(v.app.getHttpServer()).post('/capture_sessions').set(PAYMENTS).set('idempotency-key', idempotencyKey).send(body);
    expect(retry.status).toBe(201);
    expect(await sessions()).toBe(before + 1);
    const again = await request(v.app.getHttpServer()).post('/capture_sessions').set(PAYMENTS).set('idempotency-key', idempotencyKey).send(body);
    expect(again.body.id).toBe(retry.body.id);
    expect(await sessions()).toBe(before + 1);
  });
});
