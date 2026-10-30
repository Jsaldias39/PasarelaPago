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
const DB_NAME = `mantra_it_rev5_${randomBytes(5).toString('hex')}`;
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




    // ===================== VERIFICACION DEL DELTA 3a2b56836 =====================
    const log = (m: string) => process.stdout.write(`R5I> ${m}\n`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const asRls = <T,>(o: MikroORM, fn: () => Promise<T>): Promise<T> =>
      o.em.transactional(async () => {
        await o.em.execute("select set_config('app.system_context', 'false', true)");
        await o.em.execute("select set_config('app.current_tenant_id', ?, true)", [TENANT]);
        return fn();
      });
    const errOf = (p: Promise<any>) => p.then(() => 'ok', (e) => { if (e?.code === '40P01' && !(globalThis as any).__dl) { (globalThis as any).__dl = 1; process.stdout.write(`R5DL> ${String(e.detail ?? e.message).replace(/\n/g, ' // ')} :: where=${e.where ?? ''}\n`); } return fmtE(e); });
    const fmtE = (e: any) => `e${e.getStatus?.()}:${e.reason ?? ''}${e.getStatus ? '' : '[' + (e.code ?? '') + ']'}`;
    const markOf = async (id: string): Promise<string | null> =>
      (await rows(`select gateway_intent_ref r from payments.payment_intents where id = ?`, [id]))[0].r;
    const rowOf = async (id: string) => (await rows(`select status_concept_id s, gateway_intent_ref r from payments.payment_intents where id = ?`, [id]))[0];
    const stName = (s: string) => ({ [CONCEPTS.PI_PENDING]: 'PENDING', [CONCEPTS.PI_PROCESSING]: 'PROCESSING', [CONCEPTS.PI_CANCELED]: 'CANCELED' } as Record<string, string>)[s] ?? s;
    const ageMark = async (id: string, ms: number, alsoUpdatedAt = false) => {
      const m = (await markOf(id)) as string;
      await run(`update payments.payment_intents set gateway_intent_ref = ? ${alsoUpdatedAt ? ", updated_at = now() - ?::interval" : ''} where id = ?`,
        alsoUpdatedAt ? [`dispatching:${Date.now() - ms}:${m.slice(-36)}`, `${ms} milliseconds`, id] : [`dispatching:${Date.now() - ms}:${m.slice(-36)}`, id]);
    };
    const drop3 = () => [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }] as any[];
    const never3 = () => [{ kind: 'drop_before' }, { kind: 'drop_before' }, { kind: 'drop_before' }] as any[];
    const pay = (id: string, svc = on) => svc.transactions.processTransaction(id, sale(), actor);
    const REASON = 'Verificado en la consola de la pasarela: no hay cobro';
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
    const MODES = [
      ['RLS_ENFORCE=false', (fn: () => Promise<any>) => fn(), () => on],
      ['RLS_ENFORCE=true (NOBYPASSRLS)', (fn: () => Promise<any>) => asRls(ormR, fn), () => onR],
    ] as const;

    // ------------------------------------------------------------------ D8
    describe.each(MODES)('(D8) %s', (_m, wrap, svc) => {
      it('matriz: latencias 150/400/1500 ms x close a 0/60/150 ms x {cobro existia, nunca llego} x 2 rondas: ¿CANCELED con QR entregado o 2 cobros con QR?', async () => {
        const tally: Record<string, number> = {};
        let violations = 0; let rounds = 0;
        for (const kind of ['executed', 'never'] as const) {
          for (const lat of [150, 400, 1500]) {
            for (const closeAt of [0, 60, 150]) {
              for (let i = 0; i < 2; i += 1) {
                rounds += 1;
                double.created.clear(); double.calls.length = 0; double.latencyMs = 0;
                const { list } = await nOnSameDebt(2);
                const [a, b] = list;
                double.script = kind === 'executed' ? drop3() : never3();
                await errOf(wrap(() => pay(a.id, svc())));
                await ageMark(a.id, 3 * 3_600_000, true);
                double.latencyMs = lat;
                const [retry, closed] = await Promise.all([
                  errOf(wrap(() => pay(a.id, svc()))),
                  sleep(closeAt).then(() => errOf(wrap(() => svc().close(a.id, REASON)))),
                ]);
                double.latencyMs = 0;
                const row = await rowOf(a.id);
                const pb = await errOf(wrap(() => pay(b.id, svc())));
                const delivered = retry === 'ok';
                const canceled = row.s === CONCEPTS.PI_CANCELED;
                const bad = (canceled && delivered) || (delivered && pb === 'ok');
                if (bad) violations += 1;
                const k = `retry=${retry} | close=${closed} | A=${stName(row.s)}/${String(row.r).startsWith('pi_') ? 'pi_' : 'marca'} | B=${pb} | vivos=${double.createdCount}${bad ? ' <<VIOLACION>>' : ''}`;
                tally[k] = (tally[k] ?? 0) + 1;
              }
            }
          }
        }
        log(`D8 ${_m}: ${rounds} rondas; violaciones=${violations}; ${JSON.stringify(tally)}`);
        expect(violations).toBe(0);
      }, 280000);

      it('reintento CALADO (llamada en vuelo mas larga que el plazo): el close pasa, pero associate NO entrega el QR y deja el pi_ persistido', async () => {
        double.created.clear(); double.calls.length = 0; double.latencyMs = 0;
        const { list } = await nOnSameDebt(2);
        const [a, b] = list;
        double.script = drop3();
        await errOf(wrap(() => pay(a.id, svc())));
        await ageMark(a.id, 3 * 3_600_000, true);
        let closed = 'no-ejecutado';
        let first = true;
        double.onCreate = async () => {
          if (!first) return;
          first = false;
          // el reintento ya paso su compuerta y esta en vuelo; se simula que lleva > plazo sin actividad
          await ageMark(a.id, 3 * 3_600_000, true);
          closed = await errOf(wrap(() => svc().close(a.id, REASON)));
        };
        const retry = await errOf(wrap(() => pay(a.id, svc())));
        double.onCreate = undefined;
        const row = await rowOf(a.id);
        const persisted = (await rows(`select count(*)::int n from payments.payment_intents where gateway_intent_ref like 'pi_%' and id = ?`, [a.id]))[0].n;
        const pb = await errOf(wrap(() => pay(b.id, svc())));
        const again = await errOf(wrap(() => pay(a.id, svc())));
        const rec = await errOf(on.reconcile(a.id, { paymentMethodType: 'qr' }));
        const listed = (await on.list()).some((x: any) => x.paymentIntentId === a.id);
        log(`D8-calado ${_m}: close=${closed}; reintento (HTTP en vuelo)=${retry}; A=${stName(row.s)}/${String(row.r).slice(0, 5)} (pi_ persistido=${persisted === 1}); B=${pb}; reintento posterior de A=${again}; reconcile de A=${rec}; listada=${listed}; cobros vivos=${double.createdCount}`);
        expect(retry).not.toBe('ok');
      }, 60000);
    });

    // ------------------------------------------------------------------ D9
    describe.each(MODES)('(D9) %s', (_m, wrap, svc) => {
      const mkSession = async (intentId: string, debtId: string) => {
        const id = randomUUID();
        await run(
          `insert into payments.payment_checkout_sessions
             (id, tenant_id, gateway_connection_id, payment_debt_id, payment_intent_id, session_token_hash, redirect_url, expires_at, status_concept_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'https://checkout.example/s', now() + interval '1 hour', ?, now(), now())`,
          [id, TENANT, randomUUID(), debtId, intentId, randomUUID().replace(/-/g, ''), CONCEPTS.CHECKOUT_OPEN],
        );
        return id;
      };
      const mkLinked = async (debtId: string) => {
        const c = await createIntent(on, { sourceRefType: undefined, sourceRefId: undefined, purpose: 'DEBT' }, false);
        await assess(c.id, 'APPROVE');
        return c;
      };
      const state = async (debtId: string, sessions: string[]) => {
        const [d] = await rows(`select status_concept_id s from payments.payment_debts where id = ?`, [debtId]);
        const ss = await Promise.all(sessions.map(async (s) => (await rows(`select status_concept_id s from payments.payment_checkout_sessions where id = ?`, [s]))[0].s));
        const dn = d.s === CONCEPTS.DEBT_IN_CHECKOUT ? 'IN_CHECKOUT' : d.s === CONCEPTS.DEBT_PENDING ? 'PENDING' : d.s;
        return `deuda=${dn} sesiones=${ss.map((x) => (x === CONCEPTS.CHECKOUT_OPEN ? 'OPEN' : x === CONCEPTS.CHECKOUT_EXPIRED ? 'EXPIRED' : x)).join('+')}`;
      };

      it('close con sesion real: la sesion se expira y la deuda vuelve a PENDING (se puede abrir otro checkout)', async () => {
        const debtId = randomUUID();
        await insertDebt(debtId, { status: CONCEPTS.DEBT_IN_CHECKOUT });
        const a = await mkLinked(debtId);
        const sA = await mkSession(a.id, debtId);
        double.script = drop3();
        await errOf(wrap(() => pay(a.id, svc())));
        await ageMark(a.id, 3 * 3_600_000, true);
        const closed = await errOf(wrap(() => svc().close(a.id, REASON)));
        log(`D9 ${_m} sesion real: close=${closed}; ${await state(debtId, [sA])}`);
      });

      it('m6: otra intencion con sesion abierta sobre la misma deuda la mantiene IN_CHECKOUT', async () => {
        const debtId = randomUUID();
        await insertDebt(debtId, { status: CONCEPTS.DEBT_IN_CHECKOUT });
        const a = await mkLinked(debtId); const c = await mkLinked(debtId);
        const sA = await mkSession(a.id, debtId); const sC = await mkSession(c.id, debtId);
        double.script = drop3();
        await errOf(wrap(() => pay(a.id, svc())));
        await ageMark(a.id, 3 * 3_600_000, true);
        const closed = await errOf(wrap(() => svc().close(a.id, REASON)));
        log(`D9 ${_m} m6: close A=${closed}; ${await state(debtId, [sA, sC])}`);
      });

      it('sin deadlocks: dos close simultaneos de intenciones distintas con sesion sobre la misma deuda, 20 rondas', async () => {
        const errs: Record<string, number> = {};
        let ok = 0;
        for (let i = 0; i < 20; i += 1) {
          const debtId = randomUUID();
          await insertDebt(debtId, { status: CONCEPTS.DEBT_IN_CHECKOUT });
          const a = await mkLinked(debtId); const b = await mkLinked(debtId);
          const sA = await mkSession(a.id, debtId); const sB = await mkSession(b.id, debtId);
          for (const x of [a, b]) {
            await run(`update payments.payment_intents set gateway_intent_ref = ?, updated_at = now() - interval '3 hours' where id = ?`, [`dispatching:${Date.now() - 3 * 3_600_000}:${randomUUID()}`, x.id]);
          }
          const from = sqlLog.length;
          const res = await Promise.all([errOf(wrap(() => svc().close(a.id, REASON))), errOf(wrap(() => svc().close(b.id, REASON)))]);
          if (i < 2 && _m.startsWith('RLS_ENFORCE=false')) {
            const lines = sqlLog.slice(from).filter((l) => /begin|commit|rollback|update|for update/i.test(l)).map((l) => l.replace(/\[query\]\s*/, '').replace(/\s+/g, ' ').slice(0, 140));
            log(`SQL ronda ${i}: ${res.join(',')}\n${lines.join('\n')}`);
          }
          res.forEach((r) => { if (r === 'ok') ok += 1; else errs[r.slice(0, 60)] = (errs[r.slice(0, 60)] ?? 0) + 1; });
          if (i === 0) log(`D9 ${_m} dos close: ${await state(debtId, [sA, sB])}`);
        }
        log(`D9 ${_m} deadlock-soak (40 close): ok=${ok} errores=${JSON.stringify(errs)}`);
      }, 120000);
    });

    // ------------------------------------------------------------------ D12
    it('(D12) segundo close 409 ALREADY_CLOSED; y en RLS el close usa el cupo de despachos (pool=4: limite 1)', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      double.script = drop3();
      await errOf(pay(a.id));
      await ageMark(a.id, 3 * 3_600_000, true);
      const first = await errOf(on.close(a.id, REASON));
      const second = await errOf(on.close(a.id, REASON));
      log(`D12 doble close: ${first} / ${second}`);
      const cs: Created[] = [];
      for (let i = 0; i < 4; i += 1) {
        const l = (await nOnSameDebt(1)).list[0];
        double.script = drop3();
        await errOf(pay(l.id));
        await ageMark(l.id, 3 * 3_600_000, true);
        cs.push(l);
      }
      const res = await Promise.all(cs.map((c) => errOf(asRls(ormP, () => onP.close(c.id, REASON)))));
      log(`D12 4 close simultaneos en RLS con pool=4 (limite 1): ${JSON.stringify(res)}`);
    });

    it('(D12) el close tras una actividad reciente (updated_at fresco, marca vieja) responde 409 IN_FLIGHT', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      double.script = drop3();
      await errOf(pay(a.id));
      await ageMark(a.id, 3 * 3_600_000, false); // updated_at fresco
      const r = await errOf(on.close(a.id, REASON));
      await run(`update payments.payment_intents set updated_at = now() - interval '14 minutes' where id = ?`, [a.id]);
      const r14 = await errOf(on.close(a.id, REASON));
      await run(`update payments.payment_intents set updated_at = now() - interval '16 minutes' where id = ?`, [a.id]);
      const r16 = await errOf(on.close(a.id, REASON));
      log(`D8-borde updated_at: fresco=${r}; 14min=${r14}; 16min=${r16}`);
    });
  },
);
