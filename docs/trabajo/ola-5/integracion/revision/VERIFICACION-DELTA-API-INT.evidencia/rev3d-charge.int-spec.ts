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
const DB_NAME = `mantra_it_rev3_${randomBytes(5).toString('hex')}`;
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


    // ===================== VERIFICACION DEL DELTA 06ec485eb =====================
    const log = (m: string) => process.stdout.write(`R3D> ${m}\n`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const asRls = <T,>(o: MikroORM, fn: () => Promise<T>): Promise<T> =>
      o.em.transactional(async () => {
        await o.em.execute("select set_config('app.system_context', 'false', true)");
        await o.em.execute("select set_config('app.current_tenant_id', ?, true)", [TENANT]);
        return fn();
      });
    const outcome = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? 'ok' : `e${r.reason?.getStatus?.() ?? r.reason?.name}:${r.reason?.reason ?? String(r.reason?.message).slice(0, 50)}`;
    const tally = (res: PromiseSettledResult<any>[]) => {
      const t: Record<string, number> = {};
      res.forEach((r) => { const k = outcome(r); t[k] = (t[k] ?? 0) + 1; });
      return JSON.stringify(t);
    };
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
    const ageMark = async (id: string, ms: number) => {
      const m = (await markOf(id)) as string;
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now() - ms}:${m.slice(-36)}`, id]);
    };
    const drop3 = () => [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }] as any[];
    const never3 = () => [{ kind: 'drop_before' }, { kind: 'drop_before' }, { kind: 'drop_before' }] as any[];
    const pay = (id: string, svc = on, who = actor) => svc.transactions.processTransaction(id, sale(), who);
    const errOf = (p: Promise<any>) => p.then(() => 'ok', (e) => `e${e.getStatus?.()}:${e.reason}${e.details?.reconciliationRequired ? '(reconciliationRequired)' : ''}`);

    // ---------------------------------------------------------------- (1) P1
    it.each([
      ['pool=4 (limite 1): K=1', () => ormP, () => onP, 1],
      ['pool=4 (limite 1): K=4 (=pool)', () => ormP, () => onP, 4],
      ['pool=4 (limite 1): K=8 (>pool)', () => ormP, () => onP, 8],
      ['pool=10 (limite 4): K=4', () => ormP10, () => onP10, 4],
      ['pool=10 (limite 4): K=10 (=pool)', () => ormP10, () => onP10, 10],
      ['pool=10 (limite 4): K=25 (>pool)', () => ormP10, () => onP10, 25],
    ] as const)('(1/P1) RLS %s con pasarela de 300 ms', async (name, o, svc, k) => {
      double.latencyMs = 300;
      const cs: Created[] = [];
      for (let i = 0; i < k; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => asRls(o(), () => pay(c.id, svc()))));
      log(`P1 ${name}: ${tally(res)} en ${Date.now() - t0}ms; cobros creados=${double.createdCount}`);
    }, 120000);

    it('(1/P1) trafico mixto a: 6 peticiones ajenas retienen conexion 1,5 s (pool=10) y 4 despachos: no hay espera circular, todos terminan', async () => {
      double.latencyMs = 0;
      const cs: Created[] = [];
      for (let i = 0; i < 4; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const holders = Array.from({ length: 6 }, () => asRls(ormP10, () => sleep(1500)));
      await sleep(150);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => asRls(ormP10, () => pay(c.id, onP10))));
      await Promise.all(holders);
      log(`P1 mixto-a (6 ajenas x1.5s + 4 despachos): ${tally(res)} en ${Date.now() - t0}ms`);
    }, 120000);

    it('(1/P1) trafico mixto b: 6 ajenas retienen conexion 9 s (> timeout 6 s) y 4 despachos: errores ACOTADOS (no cuelgue) y el pool se recupera', async () => {
      double.latencyMs = 0;
      const cs: Created[] = [];
      for (let i = 0; i < 4; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const holders = Array.from({ length: 6 }, () => asRls(ormP10, () => sleep(9000)));
      await sleep(150);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => asRls(ormP10, () => pay(c.id, onP10))));
      const dt = Date.now() - t0;
      const marks = await Promise.all(cs.map((c) => markOf(c.id)));
      await Promise.all(holders);
      log(`P1 mixto-b (6 ajenas x9s + 4 despachos): ${tally(res)} en ${dt}ms; marcas dejadas=${JSON.stringify(marks.map((m) => (m ? m.slice(0, 12) : null)))}; cobros creados=${double.createdCount}`);
      const after = await asRls(ormP10, () => pay(cs[0].id, onP10)).then(() => 'ok', (e) => `e${e.getStatus?.() ?? e.message}`);
      log(`P1 mixto-b tras liberar: reintento de la primera=${after}`);
    }, 120000);

    it('(1/P1) trafico mixto c: 9 ajenas (1,5 s) + 4 despachos con pool=10', async () => {
      double.latencyMs = 0;
      const cs: Created[] = [];
      for (let i = 0; i < 4; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const holders = Array.from({ length: 9 }, () => asRls(ormP10, () => sleep(1500)));
      await sleep(150);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => asRls(ormP10, () => pay(c.id, onP10))));
      await Promise.all(holders);
      log(`P1 mixto-c (9 ajenas + 4 despachos): ${tally(res)} en ${Date.now() - t0}ms`);
    }, 120000);

    it('(1/P1) el cupo se libera en TODAS las salidas (404, 422 de compuerta, rechazo de la pasarela, exito): sin fuga', async () => {
      double.latencyMs = 0;
      const out: string[] = [];
      for (let i = 0; i < 6; i += 1) out.push(await errOf(asRls(ormP, () => pay(randomUUID(), onP))));
      const noRisk = await createIntent(on); // sin evaluacion de riesgo => 422 en la compuerta
      for (let i = 0; i < 3; i += 1) out.push(await errOf(asRls(ormP, () => pay(noRisk.id, onP))));
      const rej = (await nOnSameDebt(1)).list[0];
      double.script = [{ kind: 'status', status: 422, code: 'validation_failed' } as any];
      out.push(await errOf(asRls(ormP, () => pay(rej.id, onP))));
      const ok = (await nOnSameDebt(1)).list[0];
      out.push(await errOf(asRls(ormP, () => pay(ok.id, onP))));
      log(`P1 fuga de cupo (limite 1): ${out.join(' | ')}`);
      expect(out[out.length - 1]).toBe('ok');
    });

    it('(1/P1) sin transaccion de peticion (RLS_ENFORCE=false) el limite NO aplica: pool=4, 8 simultaneas, todas ok', async () => {
      double.latencyMs = 100;
      const cs: Created[] = [];
      for (let i = 0; i < 8; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const res = await Promise.allSettled(cs.map((c) => pay(c.id, onS4)));
      log(`P1 sin RLS pool=4 x8: ${tally(res)}`);
      expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    // ---------------------------------------------------------------- (2) P2
    it('(2/P2) doble clic: R1 429 agotado y R2 exito en vuelo: la reserva de R2 NO se libera; B queda 409; un solo cobro', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      let n = 0;
      double.script = [429, 429, 429].map((s) => ({ kind: 'status', status: s, code: 'rate_limited' } as any));
      double.onCreate = async () => { n += 1; if (n > 3) await sleep(600); };
      const pa1 = errOf(pay(a.id));
      await sleep(40);
      const pa2 = errOf(pay(a.id));
      await sleep(250);
      const during = await markOf(a.id);
      const pb = await errOf(pay(b.id));
      const ra = await Promise.all([pa1, pa2]);
      log(`P2 doble clic: marca de A durante la ventana=${during ? during.slice(0, 12) : null}; B=${pb}; A1/A2=${ra}; cobros vivos=${double.createdCount}; marca final A=${(await markOf(a.id))?.slice(0, 5)}`);
      expect(during).not.toBeNull();
      expect(double.createdCount).toBe(1);
    });

    // ---------------------------------------------------------------- (3) P3 + (6) F1-A
    it.each([
      ['404 sin cuerpo', { kind: 'bare_status', status: 404 }],
      ['400 sin cuerpo', { kind: 'bare_status', status: 400 }],
      ['408 sin cuerpo', { kind: 'bare_status', status: 408 }],
      ['413 sin cuerpo', { kind: 'bare_status', status: 413 }],
      ['499 sin cuerpo', { kind: 'bare_status', status: 499 }],
      ['422 con problema del contrato (validation_failed)', { kind: 'status', status: 422, code: 'validation_failed' }],
      ['400 con problema del contrato', { kind: 'status', status: 400, code: 'invalid_request' }],
      ['401 con problema del contrato', { kind: 'status', status: 401, code: 'unauthorized' }],
      ['403 con problema del contrato', { kind: 'status', status: 403, code: 'forbidden' }],
      ['404 con problema del contrato', { kind: 'status', status: 404, code: 'resource_not_found' }],
      ['409 invalid_state_transition', { kind: 'status', status: 409, code: 'invalid_state_transition' }],
      ['422 idempotency_key_reused', { kind: 'status', status: 422, code: 'idempotency_key_reused' }],
    ] as const)('(3/P3) %s: ¿conserva o libera la reserva?', async (name, fault) => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = [fault as any];
      const r = await errOf(pay(a.id));
      const mark = await markOf(a.id);
      const pb = await errOf(pay(b.id));
      log(`P3 ${name}: respuesta=${r}; marca=${mark ? 'RETENIDA' : 'LIBERADA'}; otra intencion de la deuda=${pb}`);
    });

    it('(3/P3) 429 explicito agotado (3 intentos) libera', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = [429, 429, 429].map((s) => ({ kind: 'status', status: s, code: 'rate_limited' } as any));
      const r = await errOf(pay(a.id));
      const mark = await markOf(a.id);
      const pb = await errOf(pay(b.id));
      log(`P3 429x3: ${r}; marca=${mark ? 'RETENIDA' : 'LIBERADA'}; B=${pb}`);
    });

    it('(3/P3) un 4xx con JSON ajeno al contrato que casualmente trae `code` string (proxy) ¿cuenta como contrato?', async () => {
      const { createServer } = await import('node:http');
      const srv = createServer((_q, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'upstream_blocked', message: 'x' })); });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      const port = (srv.address() as any).port;
      const client = new PaymentsGatewayClient({ ...config(true), baseUrl: `http://127.0.0.1:${port}/v1` });
      let caught: any;
      try { await client.createPaymentIntent({ amount_minor: 100, currency: 'BOB', payment_method: { type: 'qr' } } as any, 'k', {}); } catch (e) { caught = e; }
      srv.closeAllConnections(); srv.close();
      log(`P3 JSON ajeno con code string, 404: isAmbiguous=${caught?.isAmbiguous} ambiguity=${caught?.ambiguity}`);
    });

    it.each([
      ['F1-A: ambiguo (el cobro SI se ejecuto) y luego 422 definitivo', [{ kind: 'execute_then_drop' }, { kind: 'status', status: 422, code: 'validation_failed' }]],
      ['F1-A: ambiguo (nunca llego) y luego 422 definitivo', [{ kind: 'drop_before' }, { kind: 'status', status: 422, code: 'validation_failed' }]],
      ['F1-A: 5xx y luego 400 definitivo', [{ kind: 'status', status: 503, code: 'upstream' }, { kind: 'status', status: 400, code: 'bad' }]],
    ] as const)('(6) %s: la reserva se conserva y la deuda sigue bloqueada', async (name, script) => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = script as any;
      const r = await errOf(pay(a.id));
      const mark = await markOf(a.id);
      const pb = await errOf(pay(b.id));
      log(`F1A ${name}: A=${r}; marca=${mark ? 'RETENIDA' : 'LIBERADA'}; B=${pb}; creados=${double.createdCount}`);
      expect(mark).not.toBeNull();
    });

    // ---------------------------------------------------------------- (4) marca vencida
    it('(4) marca VENCIDA (3 h, y updated_at fresco): otra intencion SIGUE bloqueada, sin llamadas; list la reporta; el cobro de A existe', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = drop3();
      expect(await errOf(pay(a.id))).toMatch(/^e504/u);
      const before = await on.charge.listDispatchesRequiringReconciliation(TENANT);
      await ageMark(a.id, 3 * 3_600_000);
      await run(`update payments.payment_intents set updated_at = now() where id = ?`, [a.id]);
      const posts = double.postCalls.length;
      const pb = await errOf(pay(b.id));
      const after = await on.charge.listDispatchesRequiringReconciliation(TENANT);
      log(`EXP-a vencida: B=${pb}; POST nuevos=${double.postCalls.length - posts}; list antes=${before.some((x) => x.intentId === a.id)} despues=${after.some((x) => x.intentId === a.id)}`);
      expect(double.postCalls.length).toBe(posts);
    });

    it('(4) conciliar con marca vencida cuando el pi_ EXISTE: asocia por replay, sin segundo cobro; luego B sigue 409', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = drop3();
      await errOf(pay(a.id));
      await ageMark(a.id, 3 * 3_600_000);
      const r = await on.reconcile(a.id, { paymentMethodType: 'qr' });
      const pb = await errOf(pay(b.id));
      log(`CONC-existe: pi=${r.gatewayTransactionRef} creados=${double.createdCount} filaA=${await markOf(a.id)} B=${pb} claves=${[...new Set(double.postCalls.map((p) => p.idempotencyKey))].length}`);
      expect(double.createdCount).toBe(1);
      expect(await markOf(a.id)).toMatch(/^pi_/u);
    });

    it('(4) conciliar cuando el primer envio NUNCA llego: crea UN cobro, con la misma clave', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      double.script = never3();
      await errOf(pay(a.id));
      expect(double.createdCount).toBe(0);
      await ageMark(a.id, 2 * 3_600_000);
      const r = await on.reconcile(a.id, { paymentMethodType: 'qr' });
      const r2 = await on.reconcile(a.id, { paymentMethodType: 'qr' }); // ya asociada: no crea otro
      log(`CONC-nunca-llego: pi=${r.gatewayTransactionRef} 2a=${r2.gatewayTransactionRef} creados=${double.createdCount} claves=${[...new Set(double.postCalls.map((p) => p.idempotencyKey))].length}`);
      expect(double.createdCount).toBe(1);
    });

    it('(4) marca de mas de ~23 h: ni el reintento propio ni la conciliacion reenvian (409 RECONCILIATION_REQUIRED, cero POST); B sigue bloqueada', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = drop3();
      await errOf(pay(a.id));
      await ageMark(a.id, 24 * 3_600_000);
      const posts = double.postCalls.length;
      const own = await errOf(pay(a.id));
      const rec = await errOf(on.reconcile(a.id, { paymentMethodType: 'qr' }));
      const pb = await errOf(pay(b.id));
      log(`CONC-24h: propio=${own}; reconcile=${rec}; B=${pb}; POST nuevos=${double.postCalls.length - posts}`);
      expect(double.postCalls.length).toBe(posts);
    });

    it('(4) marca con formato ANTIGUO (97eaa006c: dispatching:<uuid>) y con fecha futura', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${randomUUID()}`, a.id]);
      const own = await errOf(pay(a.id));
      const pb = await errOf(pay(b.id));
      log(`MARCA-formato-antiguo: propio=${own}; B=${pb}`);
      const { list: l2 } = await nOnSameDebt(2);
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now() + 10 * 365 * 86_400_000}:${randomUUID()}`, l2[0].id]);
      const listed = (await on.charge.listDispatchesRequiringReconciliation(TENANT)).some((x) => x.intentId === l2[0].id);
      const pb2 = await errOf(pay(l2[1].id));
      log(`MARCA-futura: listada para conciliar=${listed}; B=${pb2}`);
    });

    it('(4) conciliar sin marca, con otro medio de pago, y desde OTRO tenant', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, c] = list;
      const none = await errOf(on.reconcile(a.id, { paymentMethodType: 'qr' }).then(() => 'ok'));
      log(`CONC-sin-marca (sin riesgo previo ni despacho): ${none}`);
      double.script = drop3();
      await errOf(pay(c.id));
      const other = await errOf(on.reconcile(c.id, { paymentMethodType: 'card' }));
      log(`CONC-otro-medio (card tras qr): ${other}; marca=${(await markOf(c.id))?.slice(0, 12)}`);
      const foreign = await errOf(on.reconcile(c.id, { paymentMethodType: 'qr' }, randomUUID()));
      log(`CONC-otro-tenant: ${foreign}`);
    });

    // ---------------------------------------------------------------- (5) riesgo
    it('(5/riesgo) sin evaluacion / REVIEW / DECLINE previos: la compuerta falla y NO deja marca', async () => {
      const none = await createIntent(on);
      const rev = await createIntent(on);
      await assess(rev.id, 'REVIEW');
      const dec = await createIntent(on);
      await assess(dec.id, 'DECLINE');
      const r = [await errOf(pay(none.id)), await errOf(pay(rev.id)), await errOf(pay(dec.id))];
      const marks = [await markOf(none.id), await markOf(rev.id), await markOf(dec.id)];
      log(`RIESGO previo: ${r.join(' | ')}; marcas=${JSON.stringify(marks)}`);
      expect(marks).toEqual([null, null, null]);
    });

    it('(5/riesgo) APPROVE -> marca (nunca llego) -> REVIEW/DECLINE registrados DESPUES -> reintento propio', async () => {
      for (const decision of ['REVIEW', 'DECLINE'] as const) {
        const { list } = await nOnSameDebt(1);
        const a = list[0];
        double.script = never3();
        await errOf(pay(a.id));
        const reg = await errOf(on.intents.assessRisk(a.id, { riskScore: '90', decision }, actor));
        const posts = double.postCalls.length;
        const retry = await errOf(pay(a.id));
        const [row] = await rows(`select status_concept_id s, gateway_intent_ref r from payments.payment_intents where id = ?`, [a.id]);
        log(`RIESGO-despues-de-marca ${decision}: registrar=${reg}; reintento=${retry}; POST nuevos=${double.postCalls.length - posts}; cobros creados=${double.createdCount}; estado=${row.s === CONCEPTS.PI_FAILED ? 'FAILED' : 'otro'}; ref=${String(row.r).slice(0, 5)}`);
      }
    });

    it('(5/riesgo) via SQL (no hay ruta de API): una marca puesta a mano en una intencion SIN evaluacion salta la compuerta de riesgo', async () => {
      const c = await createIntent(on); // sin evaluacion
      await run(`update payments.payment_intents set gateway_intent_ref = ? where id = ?`, [`dispatching:${Date.now()}:${randomUUID()}`, c.id]);
      const r = await errOf(pay(c.id));
      log(`RIESGO marca-SQL sin evaluacion: ${r}; creados=${double.createdCount}`);
    });

    it('(5/riesgo) carrera dispatch || DECLINE y dispatch || REVIEW, 30 rondas cada una: ¿puede quedar un cobro con riesgo DECLINE registrado?', async () => {
      for (const decision of ['DECLINE', 'REVIEW'] as const) {
        const pairs: Record<string, number> = {};
        let bad = 0;
        for (let i = 0; i < 30; i += 1) {
          const { list } = await nOnSameDebt(1);
          const a = list[0];
          double.latencyMs = 0;
          const [d, g] = await Promise.all([
            errOf(pay(a.id)),
            errOf(on.intents.assessRisk(a.id, { riskScore: '95', decision }, actor)),
          ]);
          const k = `dispatch=${d} | ${decision}=${g}`;
          pairs[k] = (pairs[k] ?? 0) + 1;
          if (decision === 'DECLINE' && d === 'ok' && g === 'ok') bad += 1;
        }
        log(`CARRERA ${decision}: ${JSON.stringify(pairs)}; (dispatch ok y DECLINE ok a la vez)=${bad}`);
        if (decision === 'DECLINE') expect(bad).toBe(0);
      }
    });
  },
);
