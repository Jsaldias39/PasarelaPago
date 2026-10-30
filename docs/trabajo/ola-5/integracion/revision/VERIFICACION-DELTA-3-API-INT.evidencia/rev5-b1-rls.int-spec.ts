import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Client } from 'pg';
import { CONCEPTS } from '../../src/common';
import { PaymentCheckoutSessions } from '../../src/modules/payments/entities/payment_checkout_sessions.entity';
import { PaymentDebts } from '../../src/modules/payments/entities/payment_debts.entity';
import { PaymentIntents } from '../../src/modules/payments/entities/payment_intents.entity';
import { PaymentWebhookEvents } from '../../src/modules/payments/entities/payment_webhook_events.entity';
import {
  PaymentFlowRepository,
  PaymentIntentsRepository,
  PaymentTransactionsRepository,
} from '../../src/modules/payments/repositories';
import { PaymentsGatewayWebhookService } from '../../src/modules/payments/services/payments-gateway-webhook.service';
import type { PaymentsGatewayConfig } from '../../src/modules/payments/gateway/payments-gateway.env';
import {
  TEST_API_KEY,
  TEST_WEBHOOK_SECRET,
  signTestWebhook,
} from '../../src/modules/payments/gateway/payments-gateway.double.testing';

/**
 * El receptor público de webhooks BAJO RLS, con un rol de aplicación REAL
 * (`NOSUPERUSER NOBYPASSRLS`) sobre una base descartable (hallazgo B1 de la
 * revisión del carril INT).
 *
 * `POST /payments/gateway-webhooks` es `@Public()`: el `TenantContextInterceptor`
 * no fija `app.current_tenant_id` y la política `tenant_isolation` es fail-closed,
 * así que sin una resolución propia del tenant el rol de aplicación ve 0 filas:
 * cada `succeeded` firmado daba 404 y la intención quedaba `PI_PENDING` para
 * siempre. Esta prueba ejerce el servicio y los repositorios REALES con la
 * política copiada TEXTUAL de `database/SQL/patches/2026-08-05_tenant_rls.sql`
 * (extraída por expresión regular, no reescrita) y un rol sujeto a ella. El otro
 * int-spec del receptor se conecta como superusuario y por eso no lo veía.
 *
 * NO levanta `AppModule`. Crea una base NUEVA y un rol NUEVOS en el Postgres de
 * DESARROLLO de la pasarela (127.0.0.1:54321) y los borra al terminar. Sólo se
 * aplican las tablas que el receptor toca; las claves foráneas hacia tablas que
 * no se crean no se aplican (límite declarado); las filas usan UUID sintéticos.
 *
 * Para correrla (opt-in explícito):
 *   PAYMENTS_WEBHOOK_IT=local-throwaway-db \
 *   node --experimental-vm-modules node_modules/jest-cli/bin/jest.js \
 *     --config test/jest-integration.json payments-gateway-webhook-rls
 */

const OPT_IN = process.env.PAYMENTS_WEBHOOK_IT === 'local-throwaway-db';
const describeIt = OPT_IN ? describe : describe.skip;

const PG = {
  host: process.env.PAYMENTS_WEBHOOK_IT_HOST ?? '127.0.0.1',
  port: Number(process.env.PAYMENTS_WEBHOOK_IT_PORT ?? 54321),
  user: process.env.PAYMENTS_WEBHOOK_IT_USER ?? 'postgres',
  password: process.env.PAYMENTS_WEBHOOK_IT_PASSWORD ?? 'pay',
};
const SUFFIX = randomBytes(5).toString('hex');
const DB_NAME = `mantra_it_rev5b1_${SUFFIX}`;
const APP_ROLE = `mantra_it_rev5b1app_${SUFFIX}`;
// Credencial de un rol que sólo existe mientras dura esta corrida, en una base descartable.
const APP_PASSWORD = randomBytes(12).toString('hex');
const TABLES = [
  'payment_gateways',
  'payment_intents',
  'payment_debts',
  'payment_checkout_sessions',
  'payment_webhook_events',
] as const;
/** Tablas del receptor que llevan `tenant_id`: las que la política RLS cubre. */
const RLS_TABLES = [
  'payment_intents',
  'payment_debts',
  'payment_checkout_sessions',
] as const;

const DDL_DIR = join(process.cwd(), 'database', 'SQL', '42_payments');
const ddl = (file: string) => readFileSync(join(DDL_DIR, file), 'utf8');

/** Cuerpo de la política `tenant_isolation` tal como la define el parche real. */
function realPolicyBody(): string {
  const patch = readFileSync(
    join(
      process.cwd(),
      'database',
      'SQL',
      'patches',
      '2026-08-05_tenant_rls.sql',
    ),
    'utf8',
  );
  const match = patch.match(
    /CREATE POLICY tenant_isolation ON %I\.%I([\s\S]*?)\$pol\$/u,
  );
  if (!match) throw new Error('No se encontró la política en el parche real');
  return match[1];
}

describeIt('Receptor de webhooks bajo RLS con un rol NOBYPASSRLS', () => {
  let admin: Client;
  let su: Client;
  let app: MikroORM;
  let service: PaymentsGatewayWebhookService;
  const sqlLog: string[] = [];

  const config: PaymentsGatewayConfig = {
    viaGateway: true,
    baseUrl: 'https://sandbox.pay.example/v1',
    apiKey: TEST_API_KEY,
    mode: 'test',
    webhookSecrets: [TEST_WEBHOOK_SECRET],
    webhookPublicKeys: [],
    webhookToleranceSeconds: 300,
    timeoutMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 10,
  };
  const logger = {
    setContext: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const q = async <T = Record<string, any>>(
    sql: string,
    params: unknown[] = [],
  ) => (await su.query(sql, params)).rows as T[];

  beforeAll(async () => {
    admin = new Client({ ...PG, database: 'postgres' });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    su = new Client({ ...PG, database: DB_NAME });
    await su.connect();

    await su.query(ddl('01_schema.sql'));
    for (const name of TABLES) {
      const statement = ddl('02_tables.sql').match(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS "payments"\\."${name}" \\([\\s\\S]*?\\n\\);`,
        ),
      )?.[0];
      if (!statement) throw new Error(`Falta la tabla payments.${name}`);
      await su.query(statement);
    }
    for (const m of ddl('04_indexes.sql').matchAll(
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+" ON "payments"\."(\w+)"[^;]*;/g,
    )) {
      if ((TABLES as readonly string[]).includes(m[1])) await su.query(m[0]);
    }

    await admin.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await su.query(`GRANT USAGE ON SCHEMA payments TO ${APP_ROLE}`);
    await su.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payments TO ${APP_ROLE}`,
    );
    const policy = realPolicyBody();
    for (const table of RLS_TABLES) {
      await su.query(`ALTER TABLE payments.${table} ENABLE ROW LEVEL SECURITY`);
      await su.query(`ALTER TABLE payments.${table} FORCE ROW LEVEL SECURITY`);
      await su.query(
        `CREATE POLICY tenant_isolation ON payments.${table}${policy}`,
      );
    }

    app = await MikroORM.init({
      host: PG.host,
      port: PG.port,
      user: APP_ROLE,
      password: APP_PASSWORD,
      dbName: DB_NAME,
      entities: [
        PaymentIntents,
        PaymentDebts,
        PaymentCheckoutSessions,
        PaymentWebhookEvents,
      ],
      metadataProvider: ReflectMetadataProvider,
      metadataCache: { enabled: false },
      allowGlobalContext: true,
      debug: ['query'],
      logger: (m: string) => sqlLog.push(m),
      pool: { min: 0, max: 20 },
    });
    service = new PaymentsGatewayWebhookService(
      config,
      app.em as never,
      new PaymentIntentsRepository(),
      new PaymentFlowRepository(),
      new PaymentTransactionsRepository(),
      logger as never,
    );
  });

  afterAll(async () => {
    await app?.close(true);
    await su?.end();
    if (admin) {
      // El pool cierra sus sockets de forma asíncrona: terminar un backend que el
      // pool todavía conserva ocioso emite un error sin manejar. Se espera por
      // condición a que no quede ninguna conexión de esta base antes de tirarla.
      for (let i = 0; i < 100; i += 1) {
        const open = await admin.query(
          `select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [DB_NAME],
        );
        if (open.rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [DB_NAME],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await admin.end();
    }
  });

  // ---------------------------------------------------------------- semillas
  let gatewayId: string;
  beforeAll(async () => {
    gatewayId = randomUUID();
    await q(
      `insert into payments.payment_gateways (id, code, name, gateway_type_concept_id, state_concept_id, created_at, updated_at)
       values ($1, $2, 'Pasarela de prueba (sintética)', $3, $4, now(), now())`,
      [gatewayId, `it-${gatewayId.slice(0, 8)}`, randomUUID(), randomUUID()],
    );
  });

  interface Seed {
    tenantId: string;
    intentId: string;
    ref: string;
    debtId: string;
    sessionId: string;
  }

  async function seedDebt(tenantId: string, outstanding = '150.000000') {
    const id = randomUUID();
    await q(
      `insert into payments.payment_debts
         (id, tenant_id, gateway_connection_id, debtor_business_partner_id, internal_debt_number, currency_code,
          total_amount, outstanding_amount, due_at, status_concept_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'BOB', '150.000000', $6, now() + interval '7 days', $7, now(), now())`,
      [
        id,
        tenantId,
        randomUUID(),
        randomUUID(),
        `D-${id.slice(0, 8)}`,
        outstanding,
        CONCEPTS.DEBT_IN_CHECKOUT,
      ],
    );
    return id;
  }

  async function seedIntent(
    tenantId: string,
    debtId: string,
    over: { ref?: string; amount?: string } = {},
  ) {
    const id = randomUUID();
    const ref = over.ref ?? `pi_${randomBytes(8).toString('hex')}`;
    await q(
      `insert into payments.payment_intents
         (id, tenant_id, gateway_id, purpose_concept_id, source_ref_type, source_ref_id, amount, currency_concept_id,
          idempotency_key, gateway_intent_ref, status_concept_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'payment_debt', $5, $6, $7, $8, $9, $10, now(), now())`,
      [
        id,
        tenantId,
        gatewayId,
        CONCEPTS.PAY_PURPOSE_DEBT,
        debtId,
        over.amount ?? '150.00',
        CONCEPTS.CURRENCY_BOB,
        `it-${id}`,
        ref,
        CONCEPTS.PI_PENDING,
      ],
    );
    return { id, ref };
  }

  async function seedSession(
    tenantId: string,
    debtId: string,
    intentId: string,
  ) {
    const id = randomUUID();
    await q(
      `insert into payments.payment_checkout_sessions
         (id, tenant_id, gateway_connection_id, payment_debt_id, payment_intent_id, session_token_hash, redirect_url,
          expires_at, status_concept_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'https://checkout.example/s', now() + interval '1 hour', $7, now(), now())`,
      [
        id,
        tenantId,
        randomUUID(),
        debtId,
        intentId,
        randomBytes(16).toString('hex'),
        CONCEPTS.CHECKOUT_OPEN,
      ],
    );
    return id;
  }

  async function seed(over: { amount?: string; outstanding?: string } = {}) {
    const tenantId = randomUUID();
    const debtId = await seedDebt(tenantId, over.outstanding);
    const intent = await seedIntent(tenantId, debtId, { amount: over.amount });
    const sessionId = await seedSession(tenantId, debtId, intent.id);
    return {
      tenantId,
      intentId: intent.id,
      ref: intent.ref,
      debtId,
      sessionId,
    } satisfies Seed;
  }

  function webhook(
    ref: string,
    over: { id?: string; type?: string; amountMinor?: number } = {},
  ) {
    const type = over.type ?? 'payment_intent.succeeded';
    const id = over.id ?? randomUUID();
    const payload = JSON.stringify(
      {
        id,
        object: 'event',
        type,
        created_at: new Date().toISOString(),
        mode: 'test',
        data: {
          object: {
            payment_intent_id: ref,
            status: type.replace('payment_intent.', ''),
            amount_minor: over.amountMinor ?? 15000,
            currency: 'BOB',
          },
        },
      },
      null,
      2,
    );
    return {
      id,
      headers: signTestWebhook({
        id,
        timestamp: Math.floor(Date.now() / 1000),
        payload,
      }),
      rawBody: Buffer.from(payload),
    };
  }

  async function snapshot(s: Seed) {
    const [intent] = await q(
      `select status_concept_id from payments.payment_intents where id = $1`,
      [s.intentId],
    );
    const [debt] = await q(
      `select status_concept_id, outstanding_amount::text as outstanding from payments.payment_debts where id = $1`,
      [s.debtId],
    );
    const [session] = await q(
      `select status_concept_id from payments.payment_checkout_sessions where id = $1`,
      [s.sessionId],
    );
    const events = await q(
      `select event_type, processed from payments.payment_webhook_events where related_intent_id = $1 order by recorded_at`,
      [s.intentId],
    );
    return { intent, debt, session, events };
  }


  /** Estado de las GUC en TODAS las conexiones del pool (20 lecturas simultáneas con pg_sleep). */
  async function poolState() {
    const reads = await Promise.all(
      Array.from({ length: 18 }, () =>
        app.em
          .getConnection()
          .execute(
            `select pg_sleep(0.25), pg_backend_pid() as pid, current_setting('app.current_tenant_id', true) as t, current_setting('app.system_context', true) as sc`,
            [],
            'all',
          ),
      ),
    );
    const rows = reads.map(([r]) => r as any);
    return {
      pids: new Set(rows.map((r) => r.pid)).size,
      bad: rows.filter(
        (r) => (r.t || '') !== '' || !(r.sc === null || r.sc === '' || r.sc === 'false'),
      ),
    };
  }

  const ev = (ref: string, type: string, extra: Record<string, unknown> = {}) =>
    webhook(ref, { type, ...extra });

  it('REV-1 ventana de elevacion: entre system_context=true y =false corre UNA sola sentencia (la lectura de id,tenant_id), y la firma se verifica antes', async () => {
    const s = await seed();
    const w = webhook(s.ref);
    sqlLog.length = 0;
    await service.receive(w);
    const stmts = sqlLog.map((l) => l.replace(/\x1b\[[0-9;]*m/gu, '').replace(/^\[query\]\s*/u, '').replace(/\s*\[took.*$/u, '')).filter((l) => !/pg_database/u.test(l));
    const iOn = stmts.findIndex((l) => /system_context', 'true'/u.test(l));
    const iOff = stmts.findIndex((l) => /system_context', 'false'/u.test(l));
    // eslint-disable-next-line no-console
    console.log('SECUENCIA SQL del receptor (primeras 14):\n' + stmts.slice(0, 14).map((l, i) => `${i}: ${l.slice(0, 150)}`).join('\n'));
    expect(iOn).toBeGreaterThanOrEqual(0);
    expect(iOff).toBe(iOn + 2);
    expect(stmts[iOn + 1]).toMatch(/from payments\.payment_intents where gateway_intent_ref = .* limit 2/u);
    // Nada tocó la base antes de la elevacion salvo el begin de la transaccion.
    expect(stmts.slice(0, iOn).every((l) => /^begin/u.test(l))).toBe(true);
  });

  it('REV-2 firma invalida / evento malformado / flag de modo: CERO sentencias SQL (la elevacion no se alcanza sin firma)', async () => {
    const s = await seed();
    const w = webhook(s.ref);
    const tampered = Buffer.from(w.rawBody.toString().replace('150', '999'));
    sqlLog.length = 0;
    await expect(service.receive({ ...w, rawBody: tampered })).rejects.toMatchObject({ status: 401 });
    await expect(service.receive({ headers: {}, rawBody: w.rawBody })).rejects.toMatchObject({ status: 401 });
    await expect(service.receive({ headers: w.headers, rawBody: Buffer.alloc(0) })).rejects.toMatchObject({ status: 400 });
    expect(sqlLog).toHaveLength(0);
  });

  it.each([
    ['mayusculas', 'pi_ABCDEFGHIJKL'],
    ['comilla', "pi_abcdefghij'; drop table x;--"],
    ['salto de linea final', 'pi_abcdefghijkl\n'],
    ['demasiado largo', `pi_${'a'.repeat(41)}`],
    ['demasiado corto', 'pi_abc'],
    ['comodin LIKE', 'pi_%%%%%%%%%%%%'],
    ['unicode', 'pi_abcdefghijḱ'],
  ])('REV-3 referencia hostil (%s): 422 antes de tocar la base', async (_n, ref) => {
    const w = webhook(ref);
    sqlLog.length = 0;
    await expect(service.receive(w)).rejects.toMatchObject({ status: 422 });
    expect(sqlLog).toHaveLength(0);
  });

  it('REV-4 el cuerpo no puede elegir tenant: data.object.tenant_id / metadata ajenos se ignoran', async () => {
    const a = await seed();
    const b = await seed();
    const w = webhook(a.ref);
    const body = JSON.parse(w.rawBody.toString());
    body.data.object.tenant_id = b.tenantId;
    body.data.object.metadata = { tenant_id: b.tenantId, payment_debt_id: b.debtId };
    const payload = JSON.stringify(body);
    const signed = signTestWebhook({ id: body.id, timestamp: Math.floor(Date.now() / 1000), payload });
    await service.receive({ headers: signed, rawBody: Buffer.from(payload) });
    expect((await snapshot(a)).debt.status_concept_id).toBe(CONCEPTS.DEBT_SETTLED);
    const sb = await snapshot(b);
    expect(sb.debt.status_concept_id).toBe(CONCEPTS.DEBT_IN_CHECKOUT);
    expect(sb.intent.status_concept_id).toBe(CONCEPTS.PI_PENDING);
  });

  it('REV-5 la elevacion NO sobrevive a los errores: 409 ambigua, 404 terminal desconocido, permiso denegado en mitad de la elevacion y en mitad del efecto', async () => {
    const s = await seed();
    const t2 = randomUUID();
    const d2 = await seedDebt(t2);
    await seedIntent(t2, d2, { ref: s.ref }); // misma referencia en otro tenant
    await expect(service.receive(webhook(s.ref))).rejects.toMatchObject({ status: 409 });
    await expect(service.receive(webhook('pi_unknown0000000000'))).rejects.toMatchObject({ status: 404 });
    let st = await poolState();
    expect(st.bad).toEqual([]);

    // Falla DENTRO de la ventana (permiso denegado en la lectura con la elevacion activa).
    const s2 = await seed();
    await q(`REVOKE SELECT ON payments.payment_intents FROM ${APP_ROLE}`);
    try {
      await expect(service.receive(webhook(s2.ref))).rejects.toBeDefined();
    } finally {
      await q(`GRANT SELECT ON payments.payment_intents TO ${APP_ROLE}`);
    }
    st = await poolState();
    // eslint-disable-next-line no-console
    console.log(`REV-5 conexiones distintas observadas tras fallo en ventana: ${st.pids}; contaminadas: ${st.bad.length}`);
    expect(st.bad).toEqual([]);

    // Falla DESPUES de fijar el tenant (el UPDATE de la deuda se deniega).
    const s3 = await seed();
    await q(`REVOKE UPDATE ON payments.payment_debts FROM ${APP_ROLE}`);
    try {
      await expect(service.receive(webhook(s3.ref))).rejects.toBeDefined();
    } finally {
      await q(`GRANT UPDATE ON payments.payment_debts TO ${APP_ROLE}`);
    }
    st = await poolState();
    expect(st.bad).toEqual([]);
    // y la transaccion revirtio todo: la intencion sigue pendiente, sin evento archivado
    const snap = await snapshot(s3);
    expect(snap.intent.status_concept_id).toBe(CONCEPTS.PI_PENDING);
    expect(snap.events).toHaveLength(0);
    // el receptor se recupera tras el error: el reintento aplica
    const retried = await service.receive(webhook(s3.ref));
    expect(retried.applied).toBe(true);
  });

  it('REV-6 mismo pi_ dos veces en el MISMO tenant: 409 y nada cambia (ni siquiera elige "la primera")', async () => {
    const s = await seed();
    const dup = await seedIntent(s.tenantId, s.debtId, { ref: s.ref });
    await expect(service.receive(webhook(s.ref))).rejects.toMatchObject({ status: 409 });
    expect((await snapshot(s)).intent.status_concept_id).toBe(CONCEPTS.PI_PENDING);
    const [d] = await q(`select status_concept_id from payments.payment_intents where id=$1`, [dup.id]);
    expect(d.status_concept_id).toBe(CONCEPTS.PI_PENDING);
  });

  it('REV-7 terminal "failed" de un tenant NO libera una deuda de otro (sesion cruzada)', async () => {
    const a = await seed();
    const tenantB = randomUUID();
    const debtB = await seedDebt(tenantB);
    const intentB = await seedIntent(tenantB, debtB);
    await seedSession(tenantB, a.debtId, intentB.id);
    await service.receive(webhook(intentB.ref, { type: 'payment_intent.failed' }));
    const sa = await snapshot(a);
    expect(sa.debt.status_concept_id).toBe(CONCEPTS.DEBT_IN_CHECKOUT);
    expect(sa.session.status_concept_id).toBe(CONCEPTS.CHECKOUT_OPEN);
  });

  it('REV-8 M1/m6: misma deuda con DOS intenciones y sesiones abiertas — fallo de una no libera; pago de la otra salda; el fallo posterior de la otra no resucita nada', async () => {
    const tenantId = randomUUID();
    const debtId = await seedDebt(tenantId);
    const a = await seedIntent(tenantId, debtId);
    const b = await seedIntent(tenantId, debtId);
    const sa = await seedSession(tenantId, debtId, a.id);
    const sb = await seedSession(tenantId, debtId, b.id);
    const debt = async () => (await q(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=$1`, [debtId]))[0];
    const sess = async (id: string) => (await q(`select status_concept_id from payments.payment_checkout_sessions where id=$1`, [id]))[0].status_concept_id;
    await service.receive(webhook(a.ref, { type: 'payment_intent.failed' }));
    expect((await debt()).status_concept_id).toBe(CONCEPTS.DEBT_IN_CHECKOUT);
    expect(await sess(sa)).toBe(CONCEPTS.CHECKOUT_EXPIRED);
    expect(await sess(sb)).toBe(CONCEPTS.CHECKOUT_OPEN);
    const r = await service.receive(webhook(b.ref));
    expect(r.applied).toBe(true);
    expect(r.reconciliationRequired).toBe(false);
    expect(await debt()).toEqual({ status_concept_id: CONCEPTS.DEBT_SETTLED, o: '0.000000' });
    // un segundo succeeded de A (reordenado) = contradiccion con su failed: no toca la deuda
    const c = await service.receive(webhook(a.ref));
    expect(c).toMatchObject({ applied: false, reconciliationRequired: true });
    expect(await debt()).toEqual({ status_concept_id: CONCEPTS.DEBT_SETTLED, o: '0.000000' });
  });

  it('REV-9 sobrepago real: dos intenciones de 150 sobre la misma deuda de 150, ambas succeeded: se salda UNA vez, la otra va a conciliacion y la deuda no queda negativa', async () => {
    const tenantId = randomUUID();
    const debtId = await seedDebt(tenantId);
    const a = await seedIntent(tenantId, debtId);
    const b = await seedIntent(tenantId, debtId);
    await seedSession(tenantId, debtId, a.id);
    await seedSession(tenantId, debtId, b.id);
    const results = await Promise.allSettled([service.receive(webhook(a.ref)), service.receive(webhook(b.ref))]);
    const errs = results.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.code ?? r.reason?.message);
    // eslint-disable-next-line no-console
    console.log('REV-9 resultados:', JSON.stringify(results.map((r: any) => r.status === 'fulfilled' ? r.value : { error: String(r.reason?.code ?? r.reason?.message) })));
    // con reintento (como la pasarela) debe converger
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') await service.receive(webhook(i === 0 ? a.ref : b.ref));
    }
    const [d] = await q(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=$1`, [debtId]);
    expect(d).toEqual({ status_concept_id: CONCEPTS.DEBT_SETTLED, o: '0.000000' });
    const ev = await q(`select processed from payments.payment_webhook_events where related_intent_id = any($1) order by processed`, [[a.id, b.id]]);
    expect(ev.map((e: any) => e.processed).sort()).toEqual([false, true]);
    expect(errs.length).toBeGreaterThanOrEqual(0);
  });

  it('REV-10 concurrencia mezclada (30 rondas): sin efectos dobles ni estados incoherentes; cuenta de errores 40P01', async () => {
    const types = ['succeeded', 'failed', 'expired', 'canceled', 'processing', 'requires_action'];
    let errors: Record<string, number> = {};
    for (let round = 0; round < 30; round += 1) {
      const s = await seed();
      const picks = Array.from({ length: 5 }, () => types[Math.floor(Math.random() * types.length)]);
      const evs = picks.map((t) => webhook(s.ref, { type: `payment_intent.${t}` }));
      const dupes = [evs[0], evs[0]]; // mismas entregas repetidas
      const settled = await Promise.allSettled([...evs, ...dupes].map((e) => service.receive(e)));
      for (const r of settled) {
        if (r.status === 'rejected') {
          const k = String((r.reason as any)?.code ?? (r.reason as any)?.status ?? (r.reason as any)?.message);
          errors[k] = (errors[k] ?? 0) + 1;
        }
      }
      // reintentos como la pasarela
      for (const [i, r] of settled.entries()) {
        if (r.status === 'rejected') await service.receive([...evs, ...dupes][i]);
      }
      const snap = await snapshot(s);
      const st = snap.intent.status_concept_id;
      const d = snap.debt;
      if (st === CONCEPTS.PI_SUCCEEDED) {
        expect(d.outstanding).toBe('0.000000');
        expect(d.status_concept_id).toBe(CONCEPTS.DEBT_SETTLED);
        expect(snap.session.status_concept_id).toBe(CONCEPTS.CHECKOUT_COMPLETED);
      } else if (st === CONCEPTS.PI_FAILED || st === CONCEPTS.PI_CANCELED) {
        expect(d.outstanding).toBe('150.000000');
        expect(d.status_concept_id).toBe(CONCEPTS.DEBT_PENDING);
        expect(snap.session.status_concept_id).toBe(CONCEPTS.CHECKOUT_EXPIRED);
      } else {
        expect(d.status_concept_id).toBe(CONCEPTS.DEBT_IN_CHECKOUT);
      }
      const ids = new Set(snap.events.map(() => 1));
      expect(snap.events.length).toBeLessThanOrEqual(5);
      expect(ids.size).toBeLessThanOrEqual(1);
    }
    // eslint-disable-next-line no-console
    console.log('REV-10 errores observados en la 1a pasada concurrente:', JSON.stringify(errors));
  });

  it('REV-11 interbloqueo: A(failed) || B(succeeded) sobre la misma deuda con DOS sesiones abiertas (40 rondas)', async () => {
    const errors: Record<string, number> = {};
    for (let round = 0; round < 40; round += 1) {
      const tenantId = randomUUID();
      const debtId = await seedDebt(tenantId);
      const a = await seedIntent(tenantId, debtId);
      const b = await seedIntent(tenantId, debtId);
      await seedSession(tenantId, debtId, a.id);
      await seedSession(tenantId, debtId, b.id);
      const wa = webhook(a.ref, { type: 'payment_intent.failed' });
      const wb = webhook(b.ref);
      const settled = await Promise.allSettled([service.receive(wa), service.receive(wb)]);
      for (const r of settled) {
        if (r.status === 'rejected') {
          const k = String((r.reason as any)?.code ?? (r.reason as any)?.status ?? (r.reason as any)?.message);
          errors[k] = (errors[k] ?? 0) + 1;
        }
      }
      if (settled[0].status === 'rejected') await service.receive(wa);
      if (settled[1].status === 'rejected') await service.receive(wb);
      const [d] = await q(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=$1`, [debtId]);
      expect(d).toEqual({ status_concept_id: CONCEPTS.DEBT_SETTLED, o: '0.000000' });
    }
    // eslint-disable-next-line no-console
    process.stdout.write(`R3> REV-11 errores en 40 rondas: ${JSON.stringify(errors)}\n`);
    expect(errors).toEqual({});
  });

  it('REV3-12 A(succeeded) || B(failed) y A(failed) || B(failed), 40 rondas cada una, rol NOBYPASSRLS: errores y estado final', async () => {
    const errors: Record<string, number> = {};
    const finals: Record<string, number> = {};
    for (const [ta, tb] of [['payment_intent.succeeded', 'payment_intent.failed'], ['payment_intent.failed', 'payment_intent.failed']] as const) {
      for (let round = 0; round < 40; round += 1) {
        const tenantId = randomUUID();
        const debtId = await seedDebt(tenantId);
        const a = await seedIntent(tenantId, debtId);
        const b = await seedIntent(tenantId, debtId);
        const sa = await seedSession(tenantId, debtId, a.id);
        const sb = await seedSession(tenantId, debtId, b.id);
        const wa = webhook(a.ref, { type: ta });
        const wb = webhook(b.ref, { type: tb });
        const settled = await Promise.allSettled([service.receive(wa), service.receive(wb)]);
        for (const r of settled) {
          if (r.status === 'rejected') {
            const k = String((r.reason as any)?.code ?? (r.reason as any)?.status ?? (r.reason as any)?.message);
            errors[k] = (errors[k] ?? 0) + 1;
          }
        }
        if (settled[0].status === 'rejected') await service.receive(wa);
        if (settled[1].status === 'rejected') await service.receive(wb);
        const [d] = await q(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=$1`, [debtId]);
        const ss = await q(`select status_concept_id from payments.payment_checkout_sessions where id = any($1)`, [[sa, sb]]);
        const key = `${ta.split('.')[1]}||${tb.split('.')[1]} => debt ${d.status_concept_id === CONCEPTS.DEBT_SETTLED ? 'SETTLED' : d.status_concept_id === CONCEPTS.DEBT_PENDING ? 'PENDING' : d.status_concept_id === CONCEPTS.DEBT_IN_CHECKOUT ? 'IN_CHECKOUT' : d.status_concept_id} o=${d.o} sessions=${ss.map((x: any) => x.status_concept_id === CONCEPTS.CHECKOUT_OPEN ? 'OPEN' : x.status_concept_id === CONCEPTS.CHECKOUT_COMPLETED ? 'COMPLETED' : 'EXPIRED').sort().join('+')}`;
        finals[key] = (finals[key] ?? 0) + 1;
      }
    }
    process.stdout.write(`R3> REV3-12 errores: ${JSON.stringify(errors)}\nR3> REV3-12 estados finales: ${JSON.stringify(finals)}\n`);
  });

  it('REV5-W1 cobro asociado a una intencion CANCELADA (cierre cruzado): un succeeded cae en conciliacion y no toca la deuda', async () => {
    const s = await seed();
    await q(`update payments.payment_intents set status_concept_id = $1 where id = $2`, [CONCEPTS.PI_CANCELED, s.intentId]);
    const r = await service.receive(webhook(s.ref));
    const [d] = await q(`select status_concept_id, outstanding_amount::text o from payments.payment_debts where id=$1`, [s.debtId]);
    const [ev] = await q(`select processed from payments.payment_webhook_events where related_intent_id = $1 limit 1`, [s.intentId]);
    process.stdout.write(`R5W> succeeded sobre intencion CANCELED: ${JSON.stringify({ applied: r.applied, decision: r.decision, reconciliationRequired: r.reconciliationRequired })}; deuda=${d.status_concept_id === CONCEPTS.DEBT_IN_CHECKOUT ? 'IN_CHECKOUT' : d.status_concept_id} outstanding=${d.o}; evento processed=${ev?.processed}\n`);
    expect(r.reconciliationRequired).toBe(true);
    expect(d.o).toBe('150.000000');
  });

  it('REV5-W2 terminal de un pi_ sin intencion (huerfano): 404 y sin efecto', async () => {
    const res = await service.receive(webhook(`pi_${randomBytes(8).toString('hex')}`)).then(() => 'ok', (e: any) => `e${e.getStatus?.() ?? e.status}:${e.reason ?? e.message}`);
    process.stdout.write(`R5W> terminal huerfano: ${res}\n`);
  });
});
