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
      on = build(true);
      off = build(false);
      onR = build(true, ormR);
      onP = build(true, ormP);
      onP10 = build(true, ormP10);
      onS4 = build(true, ormS4);
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

    // ===================== TERCERA REVISION ADVERSARIAL =====================
    const log = (m: string) => process.stdout.write(`R3> ${m}\n`);
    const asRls = <T,>(o: MikroORM, fn: () => Promise<T>): Promise<T> =>
      o.em.transactional(async () => {
        await o.em.execute("select set_config('app.system_context', 'false', true)");
        await o.em.execute("select set_config('app.current_tenant_id', ?, true)", [TENANT]);
        return fn();
      });
    type Mode = [string, (fn: () => Promise<any>) => Promise<any>, () => ReturnType<typeof build>];
    const MODES3: Mode[] = [
      ['RLS_ENFORCE=false (superusuario, sin transaccion de peticion)', (fn) => fn(), () => on],
      ['RLS_ENFORCE=true (rol NOBYPASSRLS + transaccion de peticion)', (fn) => asRls(ormR, fn), () => onR],
    ];
    const refsOnDebt = async (sourceRefId: string) =>
      rows<{ id: string; gateway_intent_ref: string | null }>(
        `select id, gateway_intent_ref from payments.payment_intents where source_ref_id = ?`, [sourceRefId]);
    async function nOnSameDebt(n: number) {
      const sourceRefId = randomUUID();
      const out: Created[] = [];
      for (let i = 0; i < n; i += 1) {
        const c = await createIntent(on, { sourceRefId });
        await assess(c.id, 'APPROVE');
        out.push(c);
      }
      return { list: out, sourceRefId };
    }
    const outcome = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? 'ok' : `e${r.reason?.getStatus?.() ?? r.reason?.name}:${r.reason?.reason ?? r.reason?.message?.slice(0, 60)}`;

    describe.each(MODES3)('(3) concurrencia - %s', (_n, wrap, svc) => {
      it('3 despachos simultaneos sobre la misma deuda, 20 rondas con latencia: 1 solo cobro, el resto 409, sin errores raros', async () => {
        double.latencyMs = 120;
        const tally: Record<string, number> = {};
        for (let round = 0; round < 20; round += 1) {
          double.created.clear();
          const { list, sourceRefId } = await nOnSameDebt(3);
          const res = await Promise.allSettled(
            list.map((c) => wrap(() => svc().transactions.processTransaction(c.id, sale(), actor))),
          );
          res.forEach((r) => { const k = outcome(r); tally[k] = (tally[k] ?? 0) + 1; });
          expect(double.createdCount).toBe(1);
          const refs = await refsOnDebt(sourceRefId);
          expect(refs.filter((r) => r.gateway_intent_ref?.startsWith('pi_'))).toHaveLength(1);
          expect(refs.filter((r) => r.gateway_intent_ref?.startsWith('dispatching:'))).toHaveLength(0);
        }
        log(`3-way ${_n}: ${JSON.stringify(tally)}`);
      });

      it('misma intencion x5 simultaneos: un solo cobro, una sola referencia', async () => {
        double.latencyMs = 100;
        for (let round = 0; round < 6; round += 1) {
          double.created.clear();
          const { list } = await nOnSameDebt(1);
          const res = await Promise.allSettled(
            Array.from({ length: 5 }, () => wrap(() => svc().transactions.processTransaction(list[0].id, sale(), actor))),
          );
          expect(double.createdCount).toBe(1);
          log(`same-intent x5 round ${round} ${_n}: ${res.map(outcome).join(',')}`);
          const [s0] = await rows(`select gateway_intent_ref from payments.payment_intents where id = ?`, [list[0].id]);
          expect(s0.gateway_intent_ref).toMatch(/^pi_/u);
        }
      });
    });

    it('(3) sin deadlocks: 40 rondas de 6 despachos mezclados (2 deudas x 3 intenciones) con rol NOBYPASSRLS; contar 40P01 y errores no esperados', async () => {
      double.latencyMs = 30;
      const tally: Record<string, number> = {};
      for (let round = 0; round < 40; round += 1) {
        double.created.clear();
        const d1 = await nOnSameDebt(3);
        const d2 = await nOnSameDebt(3);
        const all = [...d1.list, ...d2.list];
        const res = await Promise.allSettled(
          all.map((c) => asRls(ormR, () => onR.transactions.processTransaction(c.id, sale(), actor))),
        );
        res.forEach((r) => { const k = outcome(r); tally[k] = (tally[k] ?? 0) + 1; });
        expect(double.createdCount).toBe(2);
      }
      log(`deadlock-soak: ${JSON.stringify(tally)}`);
      expect(Object.keys(tally).filter((k) => !k.startsWith('ok') && !k.includes('PAYMENT_GATEWAY_DEBT_HAS_OPEN_CHARGE'))).toEqual([]);
    });

    it('(3/N5) el lock de la deuda NO se sostiene durante la llamada HTTP, tampoco con RLS_ENFORCE=true (rol restringido)', async () => {
      const { list, sourceRefId } = await nOnSameDebt(1);
      const seen: Record<string, string> = {};
      double.onCreate = async () => {
        for (const [t, id] of [['payment_debts', sourceRefId], ['payment_intents', list[0].id]] as const) {
          const probe = new Client({ ...PG, database: DB_NAME });
          probe.on('error', () => undefined);
          await probe.connect();
          try {
            await probe.query('begin');
            await probe.query(`select id from payments.${t} where id = $1 for update nowait`, [id]);
            seen[t] = 'libre';
          } catch (e: any) { seen[t] = e.code; } finally {
            await probe.query('rollback').catch(() => undefined);
            await probe.end();
          }
        }
        const idle = await admin.query(`select count(*)::int n from pg_stat_activity where datname=$1 and state like 'idle in transaction%' and pid<>pg_backend_pid()`, [DB_NAME]);
        seen.idleInTx = String(idle.rows[0].n);
      };
      await asRls(ormR, () => onR.transactions.processTransaction(list[0].id, sale(), actor));
      log(`N5 con RLS: ${JSON.stringify(seen)}`);
      expect(seen.payment_debts).toBe('libre');
      expect(seen.payment_intents).toBe('libre');
    });

    it.each([
      ['pool=4, 3 peticiones RLS simultaneas (K<pool)', () => ormP, () => onP, 3],
      ['pool=4, 4 peticiones RLS simultaneas (K=pool)', () => ormP, () => onP, 4],
      ['pool=4, 8 peticiones RLS simultaneas (K>pool)', () => ormP, () => onP, 8],
      ['pool=10 (DB_POOL_MAX por defecto), 9 peticiones RLS', () => ormP10, () => onP10, 9],
      ['pool=10 (DB_POOL_MAX por defecto), 10 peticiones RLS', () => ormP10, () => onP10, 10],
    ] as const)('(3/POOL) %s: hold-and-wait (interceptor toma 1 conexion y runCommitted pide otra)', async (_n, o, svc, k) => {
      double.latencyMs = 0;
      const cs = [];
      for (let i = 0; i < k; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => asRls(o(), () => svc().transactions.processTransaction(c.id, sale(), actor))));
      const tally: Record<string, number> = {};
      res.forEach((r) => { const kk = outcome(r); tally[kk] = (tally[kk] ?? 0) + 1; });
      log(`POOL ${_n}: ${JSON.stringify(tally)} en ${Date.now() - t0}ms`);
    }, 120000);

    it('(3/POOL) control: pool=4 superusuario SIN transaccion de peticion (RLS_ENFORCE=false), 8 simultaneas', async () => {
      double.latencyMs = 0;
      const cs = [];
      for (let i = 0; i < 8; i += 1) cs.push((await nOnSameDebt(1)).list[0]);
      const t0 = Date.now();
      const res = await Promise.allSettled(cs.map((c) => onS4.transactions.processTransaction(c.id, sale(), actor)));
      const tally: Record<string, number> = {};
      res.forEach((r) => { const kk = outcome(r); tally[kk] = (tally[kk] ?? 0) + 1; });
      log(`POOL control pool=4 sin RLS x8: ${JSON.stringify(tally)} en ${Date.now() - t0}ms`);
      expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    }, 120000);

    it('(2) 504 -> la propia intencion reintenta con la MISMA clave: un solo cobro (ambos modos)', async () => {
      for (const [name, wrap, svc] of MODES3) {
        double.created.clear();
        double.calls.length = 0;
        const { list } = await nOnSameDebt(1);
        const a = list[0];
        double.script = [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }];
        await expectDomainError(wrap(() => svc().transactions.processTransaction(a.id, sale(), actor)), 504);
        const [m] = await rows(`select gateway_intent_ref from payments.payment_intents where id=?`, [a.id]);
        expect(m.gateway_intent_ref).toMatch(/^dispatching:/u);
        const r = await wrap(() => svc().transactions.processTransaction(a.id, sale(), actor));
        expect(double.createdCount).toBe(1);
        expect(new Set(double.postCalls.map((p) => p.idempotencyKey))).toEqual(new Set([a.gatewayKey]));
        log(`504->retry ${name}: ref ${r.gatewayTransactionRef}, posts ${double.postCalls.length}`);
      }
    });

    it('(2) error NO de la pasarela tras reservar (p.ej. TypeError del cliente): la marca se conserva; reintento recupera con la misma clave', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      const real = (on.charge as any).client.createPaymentIntent.bind((on.charge as any).client);
      (on.charge as any).client.createPaymentIntent = async () => { throw new TypeError('boom'); };
      try {
        await expect(on.transactions.processTransaction(a.id, sale(), actor)).rejects.toThrow('boom');
      } finally { (on.charge as any).client.createPaymentIntent = real; }
      const [m] = await rows(`select gateway_intent_ref from payments.payment_intents where id=?`, [a.id]);
      log(`TypeError tras reservar: ref=${m.gateway_intent_ref}`);
      expect(m.gateway_intent_ref).toMatch(/^dispatching:/u);
      await on.transactions.processTransaction(a.id, sale(), actor);
      expect(double.createdCount).toBe(1);
    });

    it('(2) EXPIRACION a: A 504 (el cobro SI existe), marca vencida, B despacha => dos cobros vivos; el reintento legitimo de A queda 409 (cobro de A huerfano)', async () => {
      const { list, sourceRefId } = await nOnSameDebt(2);
      const [a, b] = list;
      double.script = [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }];
      await expectDomainError(on.transactions.processTransaction(a.id, sale(), actor), 504);
      await run(`update payments.payment_intents set updated_at = now() - ?::interval where id = ?`, [`${on.charge.dispatchLeaseMs + 1000} milliseconds`, a.id]);
      const rb = await on.transactions.processTransaction(b.id, sale(), actor);
      log(`EXP-a: cobros vivos en la pasarela = ${double.createdCount}; B ref ${rb.gatewayTransactionRef}`);
      const retry = await on.transactions.processTransaction(a.id, sale(), actor).then(() => 'ok', (e) => `e${e.getStatus?.()} ${e.reason}`);
      log(`EXP-a: reintento de A con la misma clave => ${retry}`);
      log(`EXP-a: refs en la deuda: ${JSON.stringify(await refsOnDebt(sourceRefId))}`);
      expect(double.createdCount).toBe(2);
    });

    it('(2) EXPIRACION b: marca vencida y nadie mas despacho: el reintento de A recupera el MISMO cobro (replay)', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      double.script = [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }];
      await expectDomainError(on.transactions.processTransaction(a.id, sale(), actor), 504);
      await run(`update payments.payment_intents set updated_at = now() - interval '3 hours' where id = ?`, [a.id]);
      const r = await on.transactions.processTransaction(a.id, sale(), actor);
      log(`EXP-b: ${r.gatewayTransactionRef}, creados=${double.createdCount}`);
      expect(double.createdCount).toBe(1);
    });

    it('(2) EXPIRACION c: la llamada de A sigue en vuelo cuando su marca vence y B despacha; al llegar la respuesta A se asocia igual => dos pi_ asociados y expuestos', async () => {
      const { list, sourceRefId } = await nOnSameDebt(2);
      const [a, b] = list;
      let first = true;
      let bRes: any;
      double.onCreate = async () => {
        if (!first) return;
        first = false;
        await run(`update payments.payment_intents set updated_at = now() - interval '3 hours' where id = ?`, [a.id]);
        bRes = await on.transactions.processTransaction(b.id, sale(), actor).then((x) => x, (e) => `e${e.getStatus?.()}`);
      };
      const ra = await on.transactions.processTransaction(a.id, sale(), actor).then((x) => x, (e) => `e${e.getStatus?.()}:${e.reason}`);
      log(`EXP-c: A=${typeof ra === 'string' ? ra : ra.gatewayTransactionRef} B=${typeof bRes === 'string' ? bRes : bRes?.gatewayTransactionRef} creados=${double.createdCount}`);
      log(`EXP-c: ${JSON.stringify(await refsOnDebt(sourceRefId))}`);
    });

    it('(1) intencion con marca: DECLINE / fx-lock / splits => 409; flag APAGADO processTransaction => 409 PAYMENT_INTENT_VIA_GATEWAY', async () => {
      const { list } = await nOnSameDebt(1);
      const a = list[0];
      double.script = [{ kind: 'drop_before' }, { kind: 'drop_before' }, { kind: 'drop_before' }];
      await expectDomainError(on.transactions.processTransaction(a.id, sale(), actor), 504);
      expect(double.createdCount).toBe(0);
      const decline = await on.intents.assessRisk(a.id, { riskScore: '99', decision: 'DECLINE' }, actor).then(() => 'ok', (e) => `e${e.getStatus?.()} ${e.reason}`);
      const offRes = await off.transactions.processTransaction(a.id, { operation: 'SALE' } as ProcessTransactionDto, actor).then(() => 'ok', (e) => `e${e.getStatus?.()} ${e.reason}`);
      log(`MARK(no hubo cobro real: drop_before) DECLINE=>${decline}; flag apagado=>${offRes}`);
    });

    it('(1) 4xx sin cuerpo del contrato (404/400/408 de un proxy) en POST: ¿libera la reserva como respuesta definitiva?', async () => {
      for (const status of [404, 400, 408, 413, 499]) {
        const { list } = await nOnSameDebt(1);
        const a = list[0];
        double.script = [{ kind: 'status', status, code: '' } as any];
        const r = await on.transactions.processTransaction(a.id, sale(), actor).then(() => 'ok', (e) => `e${e.getStatus?.()} ${e.reason}`);
        const [m] = await rows(`select gateway_intent_ref from payments.payment_intents where id=?`, [a.id]);
        log(`4xx ${status}: respuesta=${r}; reserva tras el fallo=${m.gateway_intent_ref}`);
      }
    });

    it('(2) misma intencion x2 concurrentes + rechazo definitivo (429 agotado) en una y exito en la otra: la reserva se libera mientras la otra sigue en vuelo => B despacha => dos cobros vivos', async () => {
      const { list } = await nOnSameDebt(2);
      const [a, b] = list;
      let n = 0;
      double.script = [{ kind: 'status', status: 429, code: 'rate_limited' } as any, { kind: 'status', status: 429, code: 'rate_limited' } as any, { kind: 'status', status: 429, code: 'rate_limited' } as any];
      // la 1a peticion de A consume los 3 429 (reintentos); la 2a (concurrente) llega despues y tiene exito, lenta
      double.onCreate = async () => { n += 1; if (n > 3) await new Promise((r) => setTimeout(r, 600)); };
      const pa1 = on.transactions.processTransaction(a.id, sale(), actor).then(() => 'ok', (e) => `e${e.getStatus?.()}`);
      await new Promise((r) => setTimeout(r, 40));
      const pa2 = on.transactions.processTransaction(a.id, sale(), actor).then(() => 'ok', (e) => `e${e.getStatus?.()}`);
      await new Promise((r) => setTimeout(r, 250));
      const [m] = await rows(`select gateway_intent_ref from payments.payment_intents where id=?`, [a.id]);
      const pb = await on.transactions.processTransaction(b.id, sale(), actor).then(() => 'ok', (e) => `e${e.getStatus?.()} ${e.reason}`);
      const ra = await Promise.all([pa1, pa2]);
      log(`SAME-INTENT-RACE: ref de A durante la ventana=${m.gateway_intent_ref}; B=${pb}; A1/A2=${ra}; cobros vivos=${double.createdCount}; posts=${double.postCalls.length}`);
    });
  },
);
