import 'reflect-metadata';
import { appendFileSync } from 'node:fs';
const out = (...a: unknown[]) => appendFileSync('<carpeta-de-la-evidencia>/results2.txt', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Client } from 'pg';
import { CONCEPTS } from '/home/user/mantra-core-health-api/src/common';
import { PaymentCheckoutSessions } from '/home/user/mantra-core-health-api/src/modules/payments/entities/payment_checkout_sessions.entity';
import { PaymentDebts } from '/home/user/mantra-core-health-api/src/modules/payments/entities/payment_debts.entity';
import { PaymentIntents } from '/home/user/mantra-core-health-api/src/modules/payments/entities/payment_intents.entity';
import { PaymentWebhookEvents } from '/home/user/mantra-core-health-api/src/modules/payments/entities/payment_webhook_events.entity';
import {
  PaymentFlowRepository,
  PaymentIntentsRepository,
  PaymentTransactionsRepository,
} from '/home/user/mantra-core-health-api/src/modules/payments/repositories';
import { PaymentsGatewayWebhookService } from '/home/user/mantra-core-health-api/src/modules/payments/services/payments-gateway-webhook.service';
import {
  TEST_API_KEY,
  TEST_WEBHOOK_SECRET,
  signTestWebhook,
} from '/home/user/mantra-core-health-api/src/modules/payments/gateway/payments-gateway.double.testing';

const DDL_DIR = '/home/user/mantra-core-health-api/database/SQL/42_payments';
const ddl = (f: string) => readFileSync(`${DDL_DIR}/${f}`, 'utf8');
const TABLES = ['payment_gateways','payment_intents','payment_debts','payment_checkout_sessions','payment_webhook_events'];
const PG = { host: '127.0.0.1', port: 54321, user: 'postgres', password: 'pay' };
const DB = `rev_rls_${randomBytes(5).toString('hex')}`;
const ROLE = `rev_app_${randomBytes(4).toString('hex')}`;
const config: any = { viaGateway: true, baseUrl: 'https://x.example/v1', apiKey: TEST_API_KEY, mode: 'test',
  webhookSecrets: [TEST_WEBHOOK_SECRET], webhookPublicKeys: [], webhookToleranceSeconds: 300, timeoutMs: 1000, maxAttempts: 3, retryBaseMs: 10 };
const logger: any = { setContext: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('REVISION: receptor bajo RLS (rol sin BYPASSRLS, sin GUC de tenant)', () => {
  let admin: Client; let su: MikroORM; let app: MikroORM;
  const ents = [PaymentIntents, PaymentDebts, PaymentCheckoutSessions, PaymentWebhookEvents];
  beforeAll(async () => {
    admin = new Client({ ...PG, database: 'postgres' }); await admin.connect();
    await admin.query(`CREATE DATABASE "${DB}"`);
    su = await MikroORM.init({ ...PG, dbName: DB, entities: ents, metadataProvider: ReflectMetadataProvider, metadataCache: { enabled: false }, allowGlobalContext: true });
    const run = (s: string, p: unknown[] = []) => su.em.getConnection().execute(s, p, 'run');
    await run(ddl('01_schema.sql'));
    for (const t of TABLES) {
      const st = ddl('02_tables.sql').match(new RegExp(`CREATE TABLE IF NOT EXISTS "payments"\\."${t}" \\([\\s\\S]*?\\n\\);`))![0];
      await run(st);
    }
    for (const m of ddl('04_indexes.sql').matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+" ON "payments"\."(\w+)"[^;]*;/g)) if (TABLES.includes(m[1])) await run(m[0]);
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS`);
    await run(`GRANT USAGE ON SCHEMA payments TO ${ROLE}`);
    await run(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA payments TO ${ROLE}`);
    for (const t of ['payment_intents','payment_debts','payment_checkout_sessions']) {
      await run(`ALTER TABLE payments.${t} ENABLE ROW LEVEL SECURITY`);
      await run(`ALTER TABLE payments.${t} FORCE ROW LEVEL SECURITY`);
      // politica COPIADA TEXTUAL de database/SQL/patches/2026-08-05_tenant_rls.sql
      await run(`CREATE POLICY tenant_isolation ON payments.${t}
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid OR current_setting('app.system_context', true) = 'true')
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid OR current_setting('app.system_context', true) = 'true')`);
    }
    app = await MikroORM.init({ ...PG, user: ROLE, password: 'x', dbName: DB, entities: ents, metadataProvider: ReflectMetadataProvider, metadataCache: { enabled: false }, allowGlobalContext: true });
  });
  afterAll(async () => {
    await app?.close(true); await su?.close(true);
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`, [DB]);
    await admin.query(`DROP DATABASE IF EXISTS "${DB}"`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin.end();
  });

  async function seed(su: MikroORM) {
    const run = (s: string, p: unknown[] = []) => su.em.getConnection().execute(s, p, 'run');
    const s = { intentId: randomUUID(), ref: `pi_${randomBytes(8).toString('hex')}`, debtId: randomUUID(), sessionId: randomUUID(), gatewayId: randomUUID(), tenantId: randomUUID() };
    await run(`insert into payments.payment_gateways (id, code, name, gateway_type_concept_id, state_concept_id, created_at, updated_at) values (?,?,?,?,?,now(),now())`, [s.gatewayId, `r-${s.gatewayId.slice(0,8)}`, 'sint', randomUUID(), randomUUID()]);
    await run(`insert into payments.payment_intents (id, tenant_id, gateway_id, purpose_concept_id, source_ref_type, source_ref_id, amount, currency_concept_id, idempotency_key, gateway_intent_ref, status_concept_id, created_at, updated_at) values (?,?,?,?,'payment_debt',?,?,?,?,?,?,now(),now())`,
      [s.intentId, s.tenantId, s.gatewayId, CONCEPTS.PAY_PURPOSE_DEBT, s.debtId, '150.00', CONCEPTS.CURRENCY_BOB, `r-${s.intentId}`, s.ref, CONCEPTS.PI_PENDING]);
    await run(`insert into payments.payment_debts (id, tenant_id, gateway_connection_id, debtor_business_partner_id, internal_debt_number, currency_code, total_amount, outstanding_amount, due_at, status_concept_id, created_at, updated_at) values (?,?,?,?,?,'BOB','150.000000','150.000000',now()+interval '7 days',?,now(),now())`,
      [s.debtId, s.tenantId, randomUUID(), randomUUID(), `D-${s.debtId.slice(0,8)}`, CONCEPTS.DEBT_IN_CHECKOUT]);
    await run(`insert into payments.payment_checkout_sessions (id, tenant_id, gateway_connection_id, payment_debt_id, payment_intent_id, session_token_hash, redirect_url, expires_at, status_concept_id, created_at, updated_at) values (?,?,?,?,?,?,'https://c.example/s',now()+interval '1 hour',?,now(),now())`,
      [s.sessionId, s.tenantId, randomUUID(), s.debtId, s.intentId, randomBytes(16).toString('hex'), CONCEPTS.CHECKOUT_OPEN]);
    return s;
  }
  function webhook(ref: string, type: string) {
    const id = randomUUID();
    const payload = JSON.stringify({ id, object: 'event', type, created_at: new Date().toISOString(), mode: 'test', data: { object: { payment_intent_id: ref, status: type.replace('payment_intent.', ''), amount_minor: 15000, currency: 'BOB' } } });
    return { id, headers: signTestWebhook({ id, timestamp: Math.floor(Date.now() / 1000), payload }), rawBody: Buffer.from(payload) };
  }
  const svc = (o: MikroORM) => new PaymentsGatewayWebhookService(config, o.em as never, new PaymentIntentsRepository(), new PaymentFlowRepository(), new PaymentTransactionsRepository(), logger);

  it('CONTROL superusuario: succeeded se aplica', async () => {
    const s = await seed(su);
    const r = await svc(su).receive(webhook(s.ref, 'payment_intent.succeeded'));
    out('CONTROL(su):', JSON.stringify(r));
    expect(r.applied).toBe(true);
  });
  it('rol de aplicacion bajo RLS sin GUC: succeeded', async () => {
    const s = await seed(su);
    let out: unknown;
    try { out = await svc(app).receive(webhook(s.ref, 'payment_intent.succeeded')); } catch (e: any) { out = `THROWS ${e?.constructor?.name} status=${e?.getStatus?.()} reason=${e?.reason ?? e?.response?.reason}`; }
    out('RLS(app) succeeded =>', JSON.stringify(out));
    const [row] = await su.em.getConnection().execute(`select status_concept_id from payments.payment_intents where id=?`, [s.intentId], 'all');
    out('intent local status after =>', row.status_concept_id === CONCEPTS.PI_PENDING ? 'PI_PENDING (sin cambio)' : row.status_concept_id);
  });
  it('rol de aplicacion bajo RLS sin GUC: processing (no terminal)', async () => {
    const s = await seed(su);
    let out: unknown;
    try { out = await svc(app).receive(webhook(s.ref, 'payment_intent.processing')); } catch (e: any) { out = `THROWS ${e?.constructor?.name}`; }
    out('RLS(app) processing =>', JSON.stringify(out));
  });

  it('SIN sesion de checkout: intent con source_ref=deuda se cobra y la deuda no se toca', async () => {
    const s = await seed(su);
    const run = (q: string, p: unknown[] = []) => su.em.getConnection().execute(q, p, 'run');
    await run(`delete from payments.payment_checkout_sessions where id=?`, [s.sessionId]);
    const r = await svc(su).receive(webhook(s.ref, 'payment_intent.succeeded'));
    const [d] = await su.em.getConnection().execute(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=?`, [s.debtId], 'all');
    out('SIN SESION =>', JSON.stringify(r), 'deuda:', d.o, d.status_concept_id === CONCEPTS.DEBT_IN_CHECKOUT ? 'DEBT_IN_CHECKOUT' : d.status_concept_id);
  });
  it('DOS intents sobre la misma deuda: segundo pago', async () => {
    const s = await seed(su);
    const run = (q: string, p: unknown[] = []) => su.em.getConnection().execute(q, p, 'run');
    const ref2 = `pi_${randomBytes(8).toString('hex')}`; const intent2 = randomUUID();
    await run(`insert into payments.payment_intents (id, tenant_id, gateway_id, purpose_concept_id, source_ref_type, source_ref_id, amount, currency_concept_id, idempotency_key, gateway_intent_ref, status_concept_id, created_at, updated_at) values (?,?,?,?,'payment_debt',?,?,?,?,?,?,now(),now())`,
      [intent2, s.tenantId, s.gatewayId, CONCEPTS.PAY_PURPOSE_DEBT, s.debtId, '150.00', CONCEPTS.CURRENCY_BOB, `r2-${intent2}`, ref2, CONCEPTS.PI_PENDING]);
    await run(`insert into payments.payment_checkout_sessions (id, tenant_id, gateway_connection_id, payment_debt_id, payment_intent_id, session_token_hash, redirect_url, expires_at, status_concept_id, created_at, updated_at) values (?,?,?,?,?,?,'https://c.example/s',now()+interval '1 hour',?,now(),now())`,
      [randomUUID(), s.tenantId, randomUUID(), s.debtId, intent2, randomBytes(16).toString('hex'), CONCEPTS.CHECKOUT_OPEN]);
    const r1 = await svc(su).receive(webhook(s.ref, 'payment_intent.succeeded'));
    const r2 = await svc(su).receive(webhook(ref2, 'payment_intent.succeeded'));
    const ev = await su.em.getConnection().execute(`select processed from payments.payment_webhook_events where related_intent_id in (?,?) order by recorded_at`, [s.intentId, intent2], 'all');
    out('DOS INTENTS => primero', JSON.stringify(r1), '| segundo', JSON.stringify(r2), '| processed:', JSON.stringify(ev));
  });
  it('intent con importe mayor que la deuda (150 pagados sobre deuda de 100)', async () => {
    const s = await seed(su);
    const run = (q: string, p: unknown[] = []) => su.em.getConnection().execute(q, p, 'run');
    await run(`update payments.payment_debts set outstanding_amount='100.000000', total_amount='100.000000' where id=?`, [s.debtId]);
    const r = await svc(su).receive(webhook(s.ref, 'payment_intent.succeeded'));
    const [d] = await su.em.getConnection().execute(`select outstanding_amount::text o, status_concept_id from payments.payment_debts where id=?`, [s.debtId], 'all');
    out('SOBREPAGO =>', JSON.stringify(r), 'deuda:', d.o, d.status_concept_id === CONCEPTS.DEBT_IN_CHECKOUT ? 'DEBT_IN_CHECKOUT' : d.status_concept_id);
  });
});
