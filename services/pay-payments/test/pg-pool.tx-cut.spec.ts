import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { asMerchant, httpApp } from './helpers/http';
import { eventsOf, key, MC, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * Tanda 3c · Postgres corta la conexión PRESTADA en medio de una transacción de pay-payments (`pg_terminate_backend`). Con el servicio real
 * (`PaymentsService` + Temporal + NATS + dobles), el pool de `createPgPool`, y una base real. Se exige: el proceso vivo (este worker de Jest
 * seguiría vivo; sin `guardPool` el evento `error` del cliente prestado lo tumbaría), el error del contrato (`500 internal_error` problem+json,
 * sin mensaje ni SQL), NADA a medias (la transacción se revierte entera) y que reintentar converja en UN solo efecto (regla 11: un corte no es un «no existe»).
 */
let stack: Stack;
let app: INestApplication;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };

beforeAll(async () => {
  stack = await startStack({ env: { ACTIVITY_TIMEOUT_MS: '10000', ACTIVITY_MAX_ATTEMPTS: '8', STATUS_INQUIRY_MS: '60000' } });
  app = await httpApp(stack);
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});

/** [FIXTURE de la prueba, en el esquema aislado] Un trigger que retrasa la escritura 6 s: da tiempo a cortar JUSTO en medio de la transacción. */
async function slowTrigger(table: string, event: 'INSERT' | 'UPDATE', when: string): Promise<void> {
  await stack.db.pool.query(`CREATE OR REPLACE FUNCTION test_slow_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
  await stack.db.pool.query(`CREATE TRIGGER test_slow_${table} BEFORE ${event} ON ${table} FOR EACH ROW ${when ? `WHEN (${when})` : ''} EXECUTE FUNCTION test_slow_${table}()`);
}
const dropTrigger = (table: string) => stack.db.pool.query(`DROP TRIGGER IF EXISTS test_slow_${table} ON ${table}`);
/** El backend que está dormido dentro del trigger ejecutando una sentencia que empieza con `prefix`. */
const sleeping = async (prefix: string): Promise<number | undefined> =>
  (await stack.db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event = 'PgSleep' AND query ILIKE $1 AND pid <> pg_backend_pid()", [`${prefix}%`])).rows[0]?.pid;
const cut = async (pid: number) => expect((await stack.db.pool.query('SELECT pg_terminate_backend($1) AS done', [pid])).rows[0].done).toBe(true);
const intentsOf = async (): Promise<number> => (await stack.db.pool.query('SELECT count(*)::int AS n FROM payment_intents WHERE merchant_id = $1', [MC])).rows[0].n;

describe('corte a mitad de una transacción (conexión prestada) en pay-payments', () => {
  it('crear el intento: se corta DENTRO de la transacción atómica ⇒ 500 internal_error sin mensaje, NADA a medias (ni fila ni evento) y reintentar con la MISMA clave crea UN solo intento', async () => {
    const before = await intentsOf();
    const idempotencyKey = key();
    await slowTrigger('payment_intents', 'INSERT', '');
    try {
      const pending = request(app.getHttpServer()).post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', idempotencyKey).send(QR).then((r) => r);
      const victim = await waitFor(() => sleeping('INSERT INTO payment_intents'), 15_000, 'la transacción de creación en curso');
      await cut(victim);
      const response = await pending;
      expect(response.status).toBe(500);
      expect(response.type).toBe('application/problem+json');
      expect(response.body.code).toBe('internal_error');
      expect(JSON.stringify(response.body)).not.toMatch(/terminat|administrator|payment_intents|INSERT|57P01/i);
    } finally {
      await dropTrigger('payment_intents');
    }
    // Nada a medias: la transacción se revirtió entera.
    expect(await intentsOf()).toBe(before);
    // Regla 11: el corte no es «no existe» ni «fallido»: se reintenta con la misma clave y converge en UN intento, con UN evento de creación.
    const retry = await request(app.getHttpServer()).post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', idempotencyKey).send(QR);
    expect(retry.status).toBe(201);
    expect(await intentsOf()).toBe(before + 1);
    expect((await eventsOf(stack, retry.body.id)).filter((e) => e.type === 'payment_intent.created')).toHaveLength(1);
    const again = await request(app.getHttpServer()).post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', idempotencyKey).send(QR);
    expect(again.body.id).toBe(retry.body.id);
    expect(await intentsOf()).toBe(before + 1);
  });

  it('cerrar el cobro: se corta DENTRO de la transacción que pasa el intento a succeeded ⇒ la actividad se reintenta, el intento termina succeeded UNA vez, con UN asiento y UN evento terminal', async () => {
    const id = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
    await waitFor(async () => ((await statusOf(stack, id)) === 'requires_action' ? true : undefined), 30_000, 'requires_action');
    await slowTrigger('payment_intents', 'UPDATE', "NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded'");
    try {
      stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
      await stack.orchestrator.signalCharge(id, { status: 'captured' });
      const victim = await waitFor(() => sleeping('UPDATE payment_intents'), 30_000, 'la transacción de cierre en curso');
      await cut(victim);
    } finally {
      await dropTrigger('payment_intents');
    }
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 60_000, 'succeeded tras el reintento');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect((await eventsOf(stack, id)).filter((e) => /^payment_intent\.(succeeded|failed|canceled|expired)$/.test(e.type)).map((e) => e.type)).toEqual(['payment_intent.succeeded']);
    expect((await stack.db.pool.query('SELECT count(*)::int AS n FROM intent_contradictions WHERE payment_intent_id = $1', [id])).rows[0].n).toBe(0);
  });
});
