import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Client } from 'pg';
import {
  CONCEPTS,
  runWithTenant,
  type AuthenticatedUser,
} from '../../src/common';
import { PaymentCheckoutSessions } from '../../src/modules/payments/entities/payment_checkout_sessions.entity';
import { PaymentDebts } from '../../src/modules/payments/entities/payment_debts.entity';
import { PaymentIntents } from '../../src/modules/payments/entities/payment_intents.entity';
import { PaymentTransactions } from '../../src/modules/payments/entities/payment_transactions.entity';
import { RiskAssessments } from '../../src/modules/payments/entities/risk_assessments.entity';
import {
  PaymentFlowRepository,
  PaymentIntentsRepository,
  PaymentTransactionsRepository,
} from '../../src/modules/payments/repositories';
import { PaymentsGatewayChargeService } from '../../src/modules/payments/services/payments-gateway-charge.service';
import { PaymentsIntentsService } from '../../src/modules/payments/services/payments-intents.service';
import { PaymentsTransactionsService } from '../../src/modules/payments/services/payments-transactions.service';
import { PaymentsGatewayClient } from '../../src/modules/payments/gateway/payments-gateway.client';
import type { PaymentsGatewayConfig } from '../../src/modules/payments/gateway/payments-gateway.env';
import { deriveGatewayIdempotencyKey } from '../../src/modules/payments/gateway/payments-gateway-idempotency';
import {
  PayGatewayDouble,
  TEST_API_KEY,
} from '../../src/modules/payments/gateway/payments-gateway.double.testing';
import { PaymentsErrorReason } from '../../src/modules/payments/payments.error-reasons';
import type {
  CreatePaymentIntentDto,
  ProcessTransactionDto,
} from '../../src/modules/payments/dto';

/**
 * Camino de COBRO por la pasarela contra PostgreSQL REAL (INT.H1.M2).
 *
 * Ejercita `PaymentsIntentsService.createIntent`, `assessRisk` y
 * `PaymentsTransactionsService.processTransaction` (con `payments.via_gateway`
 * encendido y apagado) con los repositorios, el `EntityManager` y las
 * transacciones REALES. El único colaborador simulado es la pasarela, y es el
 * DOBLE HTTP declarado `gateway/payments-gateway.double.testing.ts` (un servidor
 * HTTP real, no la pasarela): lo que se prueba contra él nunca se presenta como
 * resultado contra `pay-edge`.
 *
 * Lo que un doble en memoria no puede demostrar y esta prueba sí: el `FOR UPDATE`
 * real de la compuerta y de la asociación del `pi_…`, el bloqueo optimista
 * (`row_version`) de MikroORM, el rollback real de `createIntent`, y que la
 * evaluación de riesgo, las transacciones locales y la intención sean las filas
 * que de verdad se leen.
 *
 * NO levanta `AppModule` (exige Mongo y OpenSearch). Crea una base NUEVA y
 * DESCARTABLE en el Postgres del compose de DESARROLLO de la pasarela
 * (`pasarelapago/platform/compose.yml`, 127.0.0.1:54321) y la borra al terminar.
 *
 * DDL: tablas, índices y claves foráneas salen del DDL REAL del repositorio
 * (`database/SQL/42_payments/{01_schema,02_tables,03_fk_intra,04_indexes}.sql`),
 * extraídos por expresión regular, sin escribir DDL a mano. Sólo se aplican las
 * tablas que el camino de cobro toca (`payment_gateways`, `payment_intents`,
 * `payment_transactions`, `risk_assessments`). Las claves foráneas hacia tablas
 * que no se crean (conexiones, métodos de pago, etc.) y las diferidas hacia otros
 * esquemas (`90_fk_deferred.sql`) NO se aplican: es una limitación declarada, no
 * una invención; las filas usan UUID sintéticos en esas columnas. La evaluación
 * de riesgo NO exige tablas de otros módulos: `risk_assessments` sólo referencia
 * a `payment_intents`, así que se persiste con el `assessRisk` real.
 *
 * Para correrla (opt-in explícito):
 *   PAYMENTS_CHARGE_IT=local-throwaway-db \
 *   node --experimental-vm-modules node_modules/jest-cli/bin/jest.js \
 *     --config test/jest-integration.json payments-gateway-charge
 */

const OPT_IN = process.env.PAYMENTS_CHARGE_IT === 'local-throwaway-db';
const describeIt = OPT_IN ? describe : describe.skip;

// Credenciales de DESARROLLO del compose de la pasarela; sobreescribibles por entorno.
const PG = {
  host: process.env.PAYMENTS_CHARGE_IT_HOST ?? '127.0.0.1',
  port: Number(process.env.PAYMENTS_CHARGE_IT_PORT ?? 54321),
  user: process.env.PAYMENTS_CHARGE_IT_USER ?? 'postgres',
  password: process.env.PAYMENTS_CHARGE_IT_PASSWORD ?? 'pay',
};
const DB_NAME = `mantra_it_rev4_${randomBytes(5).toString('hex')}`;
const TABLES = [
  'payment_gateways',
  'payment_intents',
  'payment_transactions',
  'risk_assessments',
  // La compuerta previa contra la deuda (M2) lee la deuda y las sesiones de checkout.
  'payment_debts',
  'payment_checkout_sessions',
] as const;
const APP_ROLE = `mantra_it_rev3app_${randomBytes(4).toString('hex')}`;
const APP_PASSWORD = randomBytes(12).toString('hex');
const RLS_TABLES = ['payment_intents','payment_debts','payment_checkout_sessions'] as const;
function realPolicyBody(): string {
  const patch = readFileSync(join(process.cwd(),'database','SQL','patches','2026-08-05_tenant_rls.sql'),'utf8');
  const match = patch.match(/CREATE POLICY tenant_isolation ON %I\.%I([\s\S]*?)\$pol\$/u);
  if (!match) throw new Error('policy');
  return match[1];
}

const DDL_DIR = join(process.cwd(), 'database', 'SQL', '42_payments');
const ddl = (file: string) => readFileSync(join(DDL_DIR, file), 'utf8');

/** Sentencias del DDL real, filtradas a las tablas de la prueba. */
function realDdl(): {
  schema: string;
  tables: string[];
  indexes: string[];
  fks: string[];
  skippedFks: string[];
} {
  const tables = TABLES.map((name) => {
    const statement = ddl('02_tables.sql').match(
      new RegExp(
        `CREATE TABLE IF NOT EXISTS "payments"\\."${name}" \\([\\s\\S]*?\\n\\);`,
      ),
    )?.[0];
    if (!statement) throw new Error(`Falta la tabla canónica payments.${name}`);
    return statement;
  });
  const inSet = (t: string) => (TABLES as readonly string[]).includes(t);
  const indexes = [
    ...ddl('04_indexes.sql').matchAll(
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+" ON "payments"\."(\w+)"[^;]*;/g,
    ),
  ]
    .filter((m) => inSet(m[1]))
    .map((m) => m[0]);
  const fks: string[] = [];
  const skippedFks: string[] = [];
  for (const m of ddl('03_fk_intra.sql').matchAll(
    /DO \$\$ BEGIN\s+ALTER TABLE "payments"\."(\w+)"\s+ADD CONSTRAINT "(\w+)" FOREIGN KEY[\s\S]*?REFERENCES "payments"\."(\w+)"[\s\S]*?END \$\$;/g,
  )) {
    if (!inSet(m[1])) continue;
    (inSet(m[3]) ? fks : skippedFks).push(
      inSet(m[3]) ? m[0] : `${m[2]} -> ${m[3]}`,
    );
  }
  return { schema: ddl('01_schema.sql'), tables, indexes, fks, skippedFks };
}

const TENANT = randomUUID();
const actor: AuthenticatedUser = {
  id: randomUUID(),
  roles: ['PAYMENTS_ADMIN'],
};
const AMOUNT = '150.00';
const AMOUNT_MINOR = 15000;

const sale = (
  over: Partial<ProcessTransactionDto> = {},
): ProcessTransactionDto => ({
  operation: 'SALE',
  paymentMethodType: 'qr',
  ...over,
});

type Decision = 'APPROVE' | 'REVIEW' | 'DECLINE';

describeIt(
  'Cobro por la pasarela (createIntent + processTransaction) contra PostgreSQL real',
  () => {
    let orm: MikroORM;
    let admin: Client;
    let gatewayId: string;
    let applied: ReturnType<typeof realDdl>;
    const double = new PayGatewayDouble();
    const sqlLog: string[] = [];

    const config = (viaGateway: boolean): PaymentsGatewayConfig => ({
      viaGateway,
      baseUrl: viaGateway ? double.baseUrl : '',
      apiKey: viaGateway ? TEST_API_KEY : '',
      mode: viaGateway ? 'test' : null,
      webhookSecrets: [],
      webhookPublicKeys: [],
      webhookToleranceSeconds: 300,
      timeoutMs: 2000,
      maxAttempts: 3,
      retryBaseMs: 5,
    });
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    const run = (sql: string, params: unknown[] = []) =>
      orm.em.getConnection().execute(sql, params, 'run');
    const rows = <T = Record<string, any>>(
      sql: string,
      params: unknown[] = [],
    ) => orm.em.getConnection().execute(sql, params, 'all') as Promise<T[]>;

    /**
     * Servicios REALES sobre el `EntityManager` y los repositorios reales.
     * Con `viaGateway=false` el cobro por la pasarela recibe IGUAL un cliente que
     * apunta al doble: si el camino viejo llamara a la pasarela, el doble lo vería.
     */
    function build(viaGateway: boolean, o: MikroORM = orm) {
      const cfg = config(viaGateway);
      const intentsRepo = new PaymentIntentsRepository();
      const flowRepo = new PaymentFlowRepository();
      const txRepo = new PaymentTransactionsRepository();
      const client = new PaymentsGatewayClient({
        ...config(true),
        viaGateway: true,
      });
      const charge = new PaymentsGatewayChargeService(
        cfg,
        o.em as never,
        intentsRepo,
        logger as never,
        client,
      );
      const transactionsService = new PaymentsTransactionsService(
        o.em as never,
        intentsRepo,
        flowRepo,
        txRepo,
        logger as never,
        charge,
      );
      return {
        charge,
        intents: new PaymentsIntentsService(
          o.em as never,
          intentsRepo,
          flowRepo,
          logger as never,
          charge,
        ),
        close: (id: string, reason: string, tenant: string = TENANT) =>
          runWithTenant(tenant, () => transactionsService.closeGatewayDispatch(id, reason, actor)),
        list: (tenant: string = TENANT) =>
          runWithTenant(tenant, () => transactionsService.listGatewayDispatchesRequiringReconciliation()),
        reconcile: (id: string, dto: any, tenant: string = TENANT) =>
          runWithTenant(tenant, () => transactionsService.reconcileGatewayDispatch(id, dto)),
        transactions: {
          // El `TenantContextInterceptor` fija el tenant del actor antes del
          // servicio; aquí se hace lo mismo.
          processTransaction: (
            id: string,
            body: ProcessTransactionDto,
            who: AuthenticatedUser,
            tenant: string = TENANT,
          ) =>
            runWithTenant(tenant, () =>
              transactionsService.processTransaction(id, body, who),
            ),
        },
      };
    }
    let on: ReturnType<typeof build>;
    let off: ReturnType<typeof build>;
    let onR: ReturnType<typeof build>;
    let onP: ReturnType<typeof build>;
    let ormR: MikroORM;
    let ormP: MikroORM;
    let ormS4: MikroORM;
    let onS4: ReturnType<typeof build>;
    let ormP10: MikroORM;
    let onP10: ReturnType<typeof build>;

    beforeAll(async () => {
      // Base nueva y descartable: nombre aleatorio, creada y borrada por esta prueba.
      admin = new Client({ ...PG, database: 'postgres' });
      await admin.connect();
      const exists = await admin.query(
        'select 1 from pg_database where datname = $1',
        [DB_NAME],
      );
      if (exists.rowCount)
        throw new Error(
          `La base ${DB_NAME} ya existe: se rechaza reutilizarla`,
        );
      await admin.query(`CREATE DATABASE "${DB_NAME}"`);

      orm = await MikroORM.init({
        host: PG.host,
        port: PG.port,
        user: PG.user,
        password: PG.password,
        dbName: DB_NAME,
        entities: [
          PaymentIntents,
          PaymentTransactions,
          RiskAssessments,
          PaymentDebts,
          PaymentCheckoutSessions,
        ],
        metadataProvider: ReflectMetadataProvider,
        metadataCache: { enabled: false },
        allowGlobalContext: true,
        pool: { min: 0, max: 20 },
        debug: ['query'],
        logger: (message: string) => sqlLog.push(message),
      });

      const state = await rows<{ db: string; tables: string | null }>(
        `select current_database() as db, to_regclass('payments.payment_intents')::text as tables`,
      );
      if (state[0].db !== DB_NAME || state[0].tables) {
        throw new Error(
          'Se rechaza una base que no es la descartable y vacía de esta prueba',
        );
      }

      applied = realDdl();
      await run(applied.schema);
      for (const statement of [
        ...applied.tables,
        ...applied.indexes,
        ...applied.fks,
      ]) {
        await run(statement);
      }

      gatewayId = randomUUID();
      await run(
        `insert into payments.payment_gateways (id, code, name, gateway_type_concept_id, state_concept_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, now(), now())`,
        [
          gatewayId,
          `it-${gatewayId.slice(0, 8)}`,
          'Pasarela de prueba (sintética)',
          randomUUID(),
          randomUUID(),
        ],
      );

      await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await run(`GRANT USAGE ON SCHEMA payments TO ${APP_ROLE}`);
      await run(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payments TO ${APP_ROLE}`);
      const policy = realPolicyBody();
      for (const table of RLS_TABLES) {
        await run(`ALTER TABLE payments.${table} ENABLE ROW LEVEL SECURITY`);
        await run(`ALTER TABLE payments.${table} FORCE ROW LEVEL SECURITY`);
        await run(`CREATE POLICY tenant_isolation ON payments.${table}${policy}`);
      }
      const mk = (max: number, acquire: number) => MikroORM.init({
        host: PG.host, port: PG.port, user: APP_ROLE, password: APP_PASSWORD, dbName: DB_NAME,
        entities: [PaymentIntents, PaymentTransactions, RiskAssessments, PaymentDebts, PaymentCheckoutSessions],
        metadataProvider: ReflectMetadataProvider, metadataCache: { enabled: false }, allowGlobalContext: true,
        pool: { min: 0, max }, driverOptions: { connectionTimeoutMillis: acquire },
      });
      ormR = await mk(20, 30000);
      ormP = await mk(4, 6000);
      ormP10 = await mk(10, 6000);
      ormS4 = await MikroORM.init({
        host: PG.host, port: PG.port, user: PG.user, password: PG.password, dbName: DB_NAME,
        entities: [PaymentIntents, PaymentTransactions, RiskAssessments, PaymentDebts, PaymentCheckoutSessions],
        metadataProvider: ReflectMetadataProvider, metadataCache: { enabled: false }, allowGlobalContext: true,
        pool: { min: 0, max: 4 }, driverOptions: { connectionTimeoutMillis: 6000 },
      });
      await double.start();
      const withPool = <T,>(n: number, f: () => T): T => {
        const prev = process.env.DB_POOL_MAX;
        process.env.DB_POOL_MAX = String(n);
        try { return f(); } finally { if (prev === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = prev; }
      };
      on = build(true);
      off = build(false);
      onR = withPool(20, () => build(true, ormR));
      onP = withPool(4, () => build(true, ormP));
      onP10 = withPool(10, () => build(true, ormP10));
      onS4 = withPool(4, () => build(true, ormS4));
    });

    afterAll(async () => {
      await double.stop();
      await ormR?.close(true);
      await ormP?.close(true);
      await ormP10?.close(true);
      await ormS4?.close(true);
      await orm?.close(true);
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
        // Sólo la base propia (nombre con prefijo y sufijo aleatorio de esta corrida).
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [DB_NAME],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
        await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
        await admin.end();
      }
    });

    beforeEach(() => {
      double.calls.length = 0;
      double.created.clear();
      double.script = [];
      double.latencyMs = 0;
      double.onCreate = undefined;
    });

    // ---------------------------------------------------------------- ayudas
    interface Created {
      id: string;
      idempotencyKey: string;
      sourceRefId: string;
      /** `Idempotency-Key` que la API debe mandar a la pasarela por este cobro. */
      gatewayKey: string;
    }

    const intentDto = (
      over: Partial<CreatePaymentIntentDto> = {},
    ): CreatePaymentIntentDto => ({
      tenantId: TENANT,
      gatewayId,
      amount: AMOUNT,
      currency: 'BOB',
      purpose: 'DEBT',
      idempotencyKey: `it-chg-${randomUUID()}`,
      sourceRefType: 'payment_debt',
      sourceRefId: randomUUID(),
      ...over,
    });

    /** Deuda real que la intención cobra (la compuerta M2 la mide). */
    async function insertDebt(
      id: string,
      over: { tenantId?: string; outstanding?: string; status?: string } = {},
    ): Promise<void> {
      await run(
        `insert into payments.payment_debts
           (id, tenant_id, gateway_connection_id, debtor_business_partner_id, internal_debt_number, currency_code,
            total_amount, outstanding_amount, due_at, status_concept_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'BOB', '1000.000000', ?, now() + interval '7 days', ?, now(), now())`,
        [
          id,
          over.tenantId ?? TENANT,
          randomUUID(),
          randomUUID(),
          `D-${id.slice(0, 8)}`,
          over.outstanding ?? '1000.000000',
          over.status ?? CONCEPTS.DEBT_PENDING,
        ],
      );
    }

    /** Crea la intención con el `createIntent` REAL (y la deuda que cobra, con saldo holgado). */
    async function createIntent(
      svc: ReturnType<typeof build> = on,
      over: Partial<CreatePaymentIntentDto> = {},
      debt: { outstanding?: string; status?: string } | false = {},
    ): Promise<Created> {
      const dto = intentDto(over);
      if (debt && dto.sourceRefType === 'payment_debt' && dto.sourceRefId) {
        const [exists] = await rows(
          `select 1 from payments.payment_debts where id = ?`,
          [dto.sourceRefId],
        );
        if (!exists) await insertDebt(dto.sourceRefId, debt);
      }
      const res = await svc.intents.createIntent(dto, actor);
      return {
        id: res.id,
        idempotencyKey: dto.idempotencyKey,
        sourceRefId: dto.sourceRefId as string,
        gatewayKey: deriveGatewayIdempotencyKey({
          tenantId: dto.tenantId,
          sourceRefType: dto.sourceRefType,
          sourceRefId: dto.sourceRefId,
          invoiceId: dto.invoiceId,
          localIdempotencyKey: dto.idempotencyKey,
        }),
      };
    }

    /** Persiste una evaluación de riesgo con el `assessRisk` REAL. */
    const assess = (intentId: string, decision: Decision, score = '12.5') =>
      on.intents.assessRisk(intentId, { riskScore: score, decision }, actor);

    /** Intención lista para cobrar: creada y con evaluación `APPROVE`. */
    async function approved(): Promise<Created> {
      const c = await createIntent();
      await assess(c.id, 'APPROVE');
      return c;
    }

    const toDollars = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/gu, () => `$${(n += 1)}`);
    };

    /** Inserta una transacción local de la intención (fila real de `payment_transactions`). */
    async function insertTransaction(
      c: Created,
      status: string,
      amount: string,
      exec?: Client,
    ): Promise<string> {
      const id = randomUUID();
      const sql = `insert into payments.payment_transactions
        (id, payment_intent_id, gateway_id, transaction_type_concept_id, amount, currency_concept_id, status_concept_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, now(), now())`;
      const params = [
        id,
        c.id,
        gatewayId,
        CONCEPTS.TXN_OP_SALE,
        amount,
        CONCEPTS.CURRENCY_BOB,
        status,
      ];
      if (exec) await exec.query(toDollars(sql), params);
      else await run(sql, params);
      return id;
    }

    async function snapshot(c: Created) {
      const [intent] = await rows(
        `select status_concept_id, gateway_intent_ref, row_version, amount::text as amount
         from payments.payment_intents where id = ?`,
        [c.id],
      );
      const transactions = await rows(
        `select id, status_concept_id, amount::text as amount
         from payments.payment_transactions where payment_intent_id = ? order by created_at`,
        [c.id],
      );
      const risks = await rows(
        `select decision_concept_id from payments.risk_assessments where payment_intent_id = ?`,
        [c.id],
      );
      return { intent, transactions, risks };
    }

    const postsFor = (c: Created) =>
      double.postCalls.filter((p) => p.idempotencyKey === c.gatewayKey);
    const getsFor = (ref: string) =>
      double.calls.filter(
        (p) => p.method === 'GET' && p.path === `/v1/payment_intents/${ref}`,
      );

    /** Espera por CONDICIÓN a que algún backend de esta base esté bloqueado por un lock. */
    async function waitUntilBlocked(settled: Promise<unknown>): Promise<void> {
      let done = false;
      void settled.finally(() => {
        done = true;
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (done)
          throw new Error(
            'La operación terminó sin esperar el bloqueo de la fila: el FOR UPDATE no se tomó',
          );
        const r = await admin.query(
          `select 1 from pg_stat_activity
          where datname = $1 and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
          [DB_NAME],
        );
        if (r.rowCount) return;
        if (Date.now() > deadline)
          throw new Error('Ningún backend quedó esperando el lock');
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }

    /** Cliente propio que retiene el bloqueo de la fila de la intención dentro de una transacción. */
    async function holdIntentLock(c: Created): Promise<Client> {
      const holder = new Client({ ...PG, database: DB_NAME });
      // El fallo de una consulta ya llega por su promesa; un corte tardío del socket no debe tumbar la suite.
      holder.on('error', () => undefined);
      await holder.connect();
      await holder.query('begin');
      await holder.query(
        'select id from payments.payment_intents where id = $1 for update',
        [c.id],
      );
      return holder;
    }

    /** Aserta una excepción de dominio: estado HTTP y `reason`. */
    async function expectDomainError(
      promise: Promise<unknown>,
      status: number,
      reason?: string,
    ): Promise<any> {
      let caught: any;
      try {
        await promise;
      } catch (error) {
        caught = error;
      }
      if (!caught)
        throw new Error('Se esperaba una excepción y no hubo ninguna');
      expect(caught.getStatus?.()).toBe(status);
      if (reason) expect(caught.reason).toBe(reason);
      return caught;
    }



    // ===================== VERIFICACION DEL DELTA b881a4f15 =====================
    const log = (m: string) => process.stdout.write(`R4I> ${m}\n`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const asRls = <T,>(o: MikroORM, fn: () => Promise<T>): Promise<T> =>
      o.em.transactional(async () => {
        await o.em.execute("select set_config('app.system_context', 'false', true)");
        await o.em.execute("select set_config('app.current_tenant_id', ?, true)", [TENANT]);
        return fn();
      });
    const outcome = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? 'ok' : `e${r.reason?.getStatus?.() ?? r.reason?.name}:${r.reason?.reason ?? String(r.reason?.message).slice(0, 50)}`;
    async function nOnSameDebt(n: number) {
      const sourceRefId = randomUUID();
      const list: Created[] = [];
      for (let i = 0; i < n; i += 1) {
        const c = await createIntent(on, { sourceRefId });
        await assess(c.id, 'APPROVE');
        list.push(c);
      }
      return { list, sourceRefId };
    }
    const markOf = async (id: string): Promise<string | null> =>
      (await rows(`select gateway_intent_ref r from payments.payment_intents where id = ?`, [id]))[0].r;
    const rowOf = async (id: string) => (await rows(`select status_concept_id s, gateway_intent_ref r from payments.payment_intents where id = ?`, [id]))[0];
    const stName = (s: string) => ({ [CONCEPTS.PI_PENDING]: 'PENDING', [CONCEPTS.PI_PROCESSING]: 'PROCESSING', [CONCEPTS.PI_CANCELED]: 'CANCELED', [CONCEPTS.PI_FAILED]: 'FAILED' } as Record<string, string>)[s] ?? s;
    const ageMark = async (id: string, ms: number) => {
      const m = (await markOf(id)) as string;
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now() - ms}:${m.slice(-36)}`, id]);
    };
    const drop3 = () => [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }] as any[];
    const never3 = () => [{ kind: 'drop_before' }, { kind: 'drop_before' }, { kind: 'drop_before' }] as any[];
    const pay = (id: string, svc = on) => svc.transactions.processTransaction(id, sale(), actor);
    const errOf = (p: Promise<any>) => p.then(() => 'ok', (e) => `e${e.getStatus?.()}:${e.reason}${e.details?.reconciliationRequired ? '(reconciliationRequired)' : ''}`);
    const REASON = 'Verificado en la consola de la pasarela: no hay cobro';

    // ------------------------------------------------------------------ D1
    it('(D1) el primer envio NUNCA llego + REVIEW posterior: el reintento y la conciliacion NO crean cobro', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = never3();
      await errOf(pay(a.id));
      const reg = await errOf(on.intents.assessRisk(a.id, { riskScore: '70', decision: 'REVIEW' }, actor));
      const posts = double.postCalls.length;
      const retry = await errOf(pay(a.id));
      await ageMark(a.id, 3 * 3_600_000);
      const rec = await errOf(on.reconcile(a.id, { paymentMethodType: 'qr' }));
      const pb = await errOf(pay(b.id));
      log(`D1 REVIEW: registrar=${reg}; reintento=${retry}; reconcile=${rec}; B=${pb}; POST nuevos=${double.postCalls.length - posts}; creados=${double.createdCount}`);
      expect(double.postCalls.length).toBe(posts);
    });

    it('(D1) el primer envio NUNCA llego + DECLINE posterior: se registra, el estado NO cambia, el reintento y la conciliacion no cobran; cierre y deuda', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = never3();
      await errOf(pay(a.id));
      const reg = await errOf(on.intents.assessRisk(a.id, { riskScore: '95', decision: 'DECLINE' }, actor));
      const row = await rowOf(a.id);
      const posts = double.postCalls.length;
      const retry = await errOf(pay(a.id));
      const rec = await errOf(on.reconcile(a.id, { paymentMethodType: 'qr' }));
      const pbFresh = await errOf(pay(b.id));
      const closeFresh = await errOf(on.close(a.id, REASON));
      await ageMark(a.id, 3 * 3_600_000);
      const pbAged = await errOf(pay(b.id));
      const listed = (await on.list()).some((x: any) => x.paymentIntentId === a.id);
      const closed = await errOf(on.close(a.id, REASON));
      const pbAfter = await errOf(pay(b.id));
      const retryAfterClose = await errOf(pay(a.id));
      log(`D1 DECLINE: registrar=${reg}; estado=${stName(row.s)} ref=${String(row.r).slice(0, 12)}; reintento=${retry}; reconcile=${rec}; POST nuevos(hasta aqui)=${double.postCalls.length - posts}`);
      log(`D1 DECLINE-deuda: B(reserva fresca)=${pbFresh}; close(fresca)=${closeFresh}; B(reserva vencida)=${pbAged}; listada=${listed}; close(vencida)=${closed}; B tras close=${pbAfter}; A reintenta tras close=${retryAfterClose}; claves de A tras close=${double.postCalls.filter((p) => p.idempotencyKey === a.gatewayKey).length}`);
      expect(double.postCalls.filter((p) => p.idempotencyKey === a.gatewayKey).length).toBe(3);
    });

    it.each([
      ['el envio nunca llego', 'never'],
      ['el cobro SI se ejecuto', 'executed'],
    ] as const)('(D1) DECLINE/REVIEW y luego APPROVE (%s): destraba, un solo cobro de A, deuda sigue bloqueada para B', async (_n, kind) => {
      for (const decision of ['REVIEW', 'DECLINE'] as const) {
        double.created.clear(); double.calls.length = 0;
        const { list } = await nOnSameDebt(2);
        const [a, b] = list;
        double.script = kind === 'never' ? never3() : drop3();
        await errOf(pay(a.id));
        await on.intents.assessRisk(a.id, { riskScore: '90', decision }, actor);
        const blocked = await errOf(pay(a.id));
        await on.intents.assessRisk(a.id, { riskScore: '10', decision: 'APPROVE' }, actor);
        const r = await pay(a.id);
        const pb = await errOf(pay(b.id));
        const keys = new Set(double.postCalls.map((p) => p.idempotencyKey));
        log(`D1 ${decision}->APPROVE (${_n}): bloqueado=${blocked}; luego ref=${r.gatewayTransactionRef}; B=${pb}; cobros=${double.createdCount}; claves=${keys.size}`);
        expect(double.createdCount).toBe(1);
        expect(keys.size).toBe(1);
      }
    });

    it('(D1) carrera registrar DECLINE vs despachar (30 rondas, pasarela 80 ms, DECLINE escalonado): estados finales y cobros', async () => {
      double.latencyMs = 80;
      const pairs: Record<string, number> = {};
      let liveUnderDecline = 0; let newPostAfterDecline = 0;
      for (let i = 0; i < 30; i += 1) {
        double.created.clear();
        const { list } = await nOnSameDebt(1);
        const a = list[0];
        const dly = Math.floor((i % 10) * 12);
        const [d, g] = await Promise.all([
          errOf(pay(a.id)),
          sleep(dly).then(() => errOf(on.intents.assessRisk(a.id, { riskScore: '95', decision: 'DECLINE' }, actor))),
        ]);
        const row = await rowOf(a.id);
        const kind = String(row.r).startsWith('pi_') ? 'pi_' : String(row.r).startsWith('dispatching') ? 'marca' : 'sin-ref';
        const k = `dispatch=${d} | DECLINE=${g} | final=${stName(row.s)}/${kind}`;
        pairs[k] = (pairs[k] ?? 0) + 1;
        if (g === 'ok' && kind === 'pi_') liveUnderDecline += 1;
        const before = double.postCalls.length;
        await errOf(pay(a.id));
        if (g === 'ok' && kind !== 'pi_' && double.postCalls.length > before) newPostAfterDecline += 1;
      }
      double.latencyMs = 0;
      log(`D1 CARRERA: ${JSON.stringify(pairs)}`);
      log(`D1 CARRERA: DECLINE registrado y aun asi cobro vivo asociado (pi_)=${liveUnderDecline}; reintento posterior que CREA tras DECLINE=${newPostAfterDecline}`);
      expect(newPostAfterDecline).toBe(0);
    }, 120000);

    // ------------------------------------------------------------------ D2/D4
    it('(D2) close: no contacta la pasarela, exige reserva vencida, doble close, sin reserva, con pi_, otro tenant', async () => {
      const { list } = await nOnSameDebt(3);
      const [a, b, c] = list;
      double.script = drop3();
      await errOf(pay(a.id));
      const callsBefore = double.calls.length;
      const fresh = await errOf(on.close(a.id, REASON));
      await ageMark(a.id, 3 * 3_600_000);
      const first = await errOf(on.close(a.id, REASON));
      const second = await errOf(on.close(a.id, REASON));
      const noMark = await errOf(on.close(b.id, REASON));
      await pay(c.id); // c: ya despachada con pi_
      const withPi = await errOf(on.close(c.id, REASON));
      const foreign = await errOf(on.close(a.id, REASON, randomUUID()));
      const missing = await errOf(on.close(randomUUID(), REASON));
      const row = await rowOf(a.id);
      log(`D2 close: fresca=${fresh}; vencida=${first}; segundo=${second}; sin reserva=${noMark}; con pi_=${withPi}; otro tenant=${foreign}; inexistente=${missing}; llamadas a la pasarela durante los close=${double.calls.length - callsBefore - 1}; A=${stName(row.s)}/${String(row.r).slice(0, 12)}`);
      const cobroDeA = double.created.get(a.gatewayKey)?.intent.id;
      const resolvable = (await rows(`select count(*)::int n from payments.payment_intents where gateway_intent_ref = ?`, [cobroDeA]))[0].n;
      log(`D2 huerfano: el cobro ${String(cobroDeA).slice(0, 8)}… de A existe en la pasarela; intenciones locales que lo referencian=${resolvable} (un webhook terminal suyo respondera 404; no puede reabrir la deuda)`);
    });

    it('(D4) marcas sin fecha (formato antiguo) y con fecha futura: listables y cerrables', async () => {
      const { list } = await nOnSameDebt(4);
      const [oldFmt, future, nearFuture, ok] = list;
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${randomUUID()}`, oldFmt.id]);
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now() + 10 * 365 * 86_400_000}:${randomUUID()}`, future.id]);
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now() + 60_000}:${randomUUID()}`, nearFuture.id]);
      const l = await on.list();
      const find = (id: string) => l.find((x: any) => x.paymentIntentId === id);
      log(`D4 listado: formato-antiguo=${JSON.stringify(find(oldFmt.id))}; fecha-futura-lejana=${JSON.stringify(find(future.id))}; futura<5min=${JSON.stringify(find(nearFuture.id))}`);
      const cOld = await errOf(on.close(oldFmt.id, REASON));
      const cFut = await errOf(on.close(future.id, REASON));
      const cNear = await errOf(on.close(nearFuture.id, REASON));
      const rOld = await errOf(on.reconcile(oldFmt.id, { paymentMethodType: 'qr' }));
      log(`D4 close: formato-antiguo=${cOld}; futura-lejana=${cFut}; futura<5min=${cNear}; (reconcile del antiguo=${rOld})`);
      void ok;
    });

    // ------------------------------------------------------------------ D8
    describe.each([
      ['RLS_ENFORCE=false', (fn: () => Promise<any>) => fn(), () => on],
      ['RLS_ENFORCE=true (NOBYPASSRLS)', (fn: () => Promise<any>) => asRls(ormR, fn), () => onR],
    ] as const)('(D8) close concurrente con el reintento en vuelo - %s', (_m, wrap, svc) => {
      it.each([
        ['el cobro SI existia (replay)', 'executed'],
        ['el primer envio nunca llego (el reintento crea)', 'never'],
      ] as const)('%s: close a los 120 ms del reintento (pasarela 400 ms), 6 rondas', async (_n, kind) => {
        const tallyRounds: Record<string, number> = {};
        let doubleLive = 0;
        for (let i = 0; i < 6; i += 1) {
          double.created.clear(); double.calls.length = 0; double.latencyMs = 0;
          const { list } = await nOnSameDebt(2);
          const [a, b] = list;
          double.script = kind === 'executed' ? drop3() : never3();
          await errOf(wrap(() => pay(a.id, svc())));
          await ageMark(a.id, 3 * 3_600_000);
          double.latencyMs = 400;
          const pRetry = errOf(wrap(() => pay(a.id, svc())));
          await sleep(120);
          const pClose = errOf(wrap(() => svc().close(a.id, REASON)));
          const [retry, closed] = await Promise.all([pRetry, pClose]);
          double.latencyMs = 0;
          const row = await rowOf(a.id);
          const pb = await errOf(wrap(() => pay(b.id, svc())));
          const refA = String(row.r).startsWith('pi_');
          const live = double.createdCount;
          if (live >= 2) doubleLive += 1;
          const key = `retry=${retry} | close=${closed} | A=${stName(row.s)}/${refA ? 'pi_' : 'marca'} | B=${pb} | cobros vivos=${live}`;
          tallyRounds[key] = (tallyRounds[key] ?? 0) + 1;
        }
        log(`D8 ${_m} / ${_n}: ${JSON.stringify(tallyRounds)}; rondas con 2 cobros vivos=${doubleLive}/6`);
      }, 180000);

      it('close y reintento arrancando a la vez (Promise.all), 12 rondas: ¿queda alguna intencion CANCELED con pi_ asociado y deuda libre?', async () => {
        const tallyRounds: Record<string, number> = {};
        let canceledWithPi = 0;
        for (let i = 0; i < 12; i += 1) {
          double.created.clear(); double.calls.length = 0; double.latencyMs = 0;
          const { list } = await nOnSameDebt(2);
          const [a, b] = list;
          double.script = drop3();
          await errOf(wrap(() => pay(a.id, svc())));
          await ageMark(a.id, 3 * 3_600_000);
          double.latencyMs = 300;
          const [retry, closed] = await Promise.all([
            errOf(wrap(() => pay(a.id, svc()))),
            sleep((i % 4) * 15).then(() => errOf(wrap(() => svc().close(a.id, REASON)))),
          ]);
          double.latencyMs = 0;
          const row = await rowOf(a.id);
          const pb = await errOf(wrap(() => pay(b.id, svc())));
          if (row.s === CONCEPTS.PI_CANCELED && String(row.r).startsWith('pi_')) canceledWithPi += 1;
          const key = `retry=${retry} | close=${closed} | A=${stName(row.s)}/${String(row.r).startsWith('pi_') ? 'pi_' : 'marca'} | B=${pb} | vivos=${double.createdCount}`;
          tallyRounds[key] = (tallyRounds[key] ?? 0) + 1;
        }
        log(`D8 simultaneo ${_m}: ${JSON.stringify(tallyRounds)}; CANCELED con pi_=${canceledWithPi}/12`);
      }, 180000);
    });
  },
);
