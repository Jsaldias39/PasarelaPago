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
const DB_NAME = `mantra_it_revchg_${randomBytes(5).toString('hex')}`;
const TABLES = [
  'payment_gateways',
  'payment_intents',
  'payment_transactions',
  'risk_assessments',
  // La compuerta previa contra la deuda (M2) lee la deuda y las sesiones de checkout.
  'payment_debts',
  'payment_checkout_sessions',
] as const;

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
    function build(viaGateway: boolean) {
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
        orm.em as never,
        intentsRepo,
        logger as never,
        client,
      );
      const transactionsService = new PaymentsTransactionsService(
        orm.em as never,
        intentsRepo,
        flowRepo,
        txRepo,
        logger as never,
        charge,
      );
      return {
        charge,
        intents: new PaymentsIntentsService(
          orm.em as never,
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

      await double.start();
      on = build(true);
      off = build(false);
    });

    afterAll(async () => {
      await double.stop();
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
        await admin.end();
      }
    });

    beforeEach(() => {
      double.calls.length = 0;
      double.created.clear();
      double.script = [];
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

    // ============================ REVISION ADVERSARIAL (re-revision INT) ============================
    /** Retrasa la respuesta del doble para ensanchar la ventana HTTP (la respuesta SI llega y es valida). */
    function slowDouble(ms: number) {
      const d = double as any;
      if (!d.__orig) d.__orig = d.createIntent.bind(d);
      d.createIntent = async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, ms));
        return d.__orig(...args);
      };
    }
    const fastDouble = () => {
      const d = double as any;
      if (d.__orig) d.createIntent = d.__orig;
    };

    /** Lo que hace `TenantContextInterceptor` con RLS_ENFORCE=true: la peticion entera en UNA transaccion. */
    const asRlsInterceptor = <T,>(fn: () => Promise<T>): Promise<T> =>
      orm.em.transactional(async () => {
        await orm.em.execute("select set_config('app.system_context', 'false', true)");
        await orm.em.execute("select set_config('app.current_tenant_id', ?, true)", [TENANT]);
        return fn();
      });

    async function twoOnSameDebt(over: Partial<CreatePaymentIntentDto> = {}) {
      const sourceRefId = randomUUID();
      const a = await createIntent(on, { sourceRefId });
      const b = await createIntent(on, { sourceRefId, ...over });
      await assess(a.id, 'APPROVE');
      await assess(b.id, 'APPROVE');
      return { a, b, sourceRefId };
    }

    it('REV-M2a carrera residual SIN transaccion envolvente (RLS_ENFORCE=false): dos despachos simultaneos sobre la misma deuda', async () => {
      slowDouble(250);
      let both = 0;
      const rounds = 8;
      try {
        for (let i = 0; i < rounds; i += 1) {
          double.created.clear();
          const { a, b } = await twoOnSameDebt();
          const res = await Promise.allSettled([
            on.transactions.processTransaction(a.id, sale(), actor),
            on.transactions.processTransaction(b.id, sale(), actor),
          ]);
          if (res.every((r) => r.status === 'fulfilled')) both += 1;
        }
      } finally {
        fastDouble();
      }
      // eslint-disable-next-line no-console
      console.log(`REV-M2a rondas con DOS cobros vivos sobre la misma deuda: ${both}/${rounds}`);
      expect(both).toBeGreaterThan(0);
    });

    it('REV-M2b misma carrera CON transaccion envolvente (RLS_ENFORCE=true): se cierra, a costa de sostener el bloqueo de la deuda durante TODA la llamada HTTP', async () => {
      slowDouble(900);
      let both = 0;
      let lockHeldDuringHttp = false;
      try {
        for (let i = 0; i < 4; i += 1) {
          double.created.clear();
          const { a, b, sourceRefId } = await twoOnSameDebt();
          const pa = asRlsInterceptor(() => on.transactions.processTransaction(a.id, sale(), actor));
          // mientras la llamada HTTP de A esta en vuelo, ¿la fila de la deuda esta bloqueada?
          await new Promise((r) => setTimeout(r, 350));
          if (i === 0) {
            const probe = new Client({ ...PG, database: DB_NAME });
            probe.on('error', () => undefined);
            await probe.connect();
            try {
              await probe.query('begin');
              await probe.query('select id from payments.payment_debts where id = $1 for update nowait', [sourceRefId]);
            } catch (e: any) {
              lockHeldDuringHttp = e.code === '55P03';
            } finally {
              await probe.query('rollback').catch(() => undefined);
              await probe.end();
            }
          }
          const pb = asRlsInterceptor(() => on.transactions.processTransaction(b.id, sale(), actor));
          const res = await Promise.allSettled([pa, pb]);
          if (res.every((r) => r.status === 'fulfilled')) both += 1;
        }
      } finally {
        fastDouble();
      }
      // eslint-disable-next-line no-console
      console.log(`REV-M2b rondas con dos cobros vivos: ${both}/4; deuda bloqueada durante la llamada HTTP: ${lockHeldDuringHttp}`);
      expect(both).toBe(0);
      expect(lockHeldDuringHttp).toBe(true);
    });

    it.each([
      ['sourceRefType en mayusculas', { sourceRefType: 'PAYMENT_DEBT' }],
      ['sourceRefType distinto', { sourceRefType: 'debt' }],
      ['sin sourceRefType (solo sourceRefId)', { sourceRefType: undefined }],
    ])('REV-M2c compuerta esquivada con %s: la deuda ya tiene un cobro vivo y el segundo se despacha igual', async (_n, over) => {
      const { a, b } = await twoOnSameDebt(over as Partial<CreatePaymentIntentDto>);
      await on.transactions.processTransaction(a.id, sale(), actor);
      const res = await on.transactions.processTransaction(b.id, sale(), actor).then(() => 'despachado', (e) => `rechazado ${e.getStatus?.()}`);
      // eslint-disable-next-line no-console
      console.log(`REV-M2c (${_n}) => ${res}`);
      expect(res).toBe('despachado');
    });

    it('REV-M2d ventana ambigua: tras un 504 la deuda NO queda reservada; otra intencion se despacha y la primera ya no puede reintentar (hay DOS pi_ vivos y uno sin asociar)', async () => {
      const { a, b } = await twoOnSameDebt();
      double.script = [{ kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }, { kind: 'execute_then_drop' }];
      await expectDomainError(on.transactions.processTransaction(a.id, sale(), actor), 504);
      expect(double.createdCount).toBe(1);
      await on.transactions.processTransaction(b.id, sale(), actor);
      expect(double.createdCount).toBe(2);
      const retry = await on.transactions.processTransaction(a.id, sale(), actor).then(() => 'ok', (e) => `rechazado ${e.getStatus?.()} ${e.reason}`);
      // eslint-disable-next-line no-console
      console.log(`REV-M2d reintento de A tras despachar B: ${retry}; cobros vivos en la pasarela: ${double.createdCount}`);
    });

    it('REV-M3a sin contexto de tenant (superadmin sin X-Tenant-Id): 412 y nada se toca', async () => {
      const c = await approved();
      const svc = (on as any);
      const before = await snapshot(c);
      // processTransaction directo, sin runWithTenant
      const { PaymentsTransactionsService: S } = await import('../../src/modules/payments/services/payments-transactions.service');
      const t = new S(orm.em as never, new PaymentIntentsRepository(), new PaymentFlowRepository(), new PaymentTransactionsRepository(), logger as never, on.charge);
      void svc;
      await expectDomainError(t.processTransaction(c.id, sale(), { id: randomUUID(), roles: ['SUPERADMIN'] } as never), 422);
      expect(double.calls).toHaveLength(0);
      expect((await snapshot(c)).intent).toEqual(before.intent);
    });

    it('REV-M3b oraculo de existencia por tiempo: con la fila de la victima bloqueada, una peticion de OTRO tenant ESPERA el lock (UUID existente) mientras un UUID inexistente responde al instante', async () => {
      const c = await approved();
      const holder = await holdIntentLock(c);
      let waited = false;
      let settledAt = 0;
      const t0 = Date.now();
      const foreign = on.transactions.processTransaction(c.id, sale(), actor, randomUUID()).then(() => 'ok', (e) => `e${e.getStatus?.()}`).then((r) => { settledAt = Date.now() - t0; return r; });
      await new Promise((r) => setTimeout(r, 700));
      waited = settledAt === 0;
      const t1 = Date.now();
      const ghost = await on.transactions.processTransaction(randomUUID(), sale(), actor, randomUUID()).then(() => 'ok', (e) => `e${e.getStatus?.()}`);
      const ghostMs = Date.now() - t1;
      await holder.query('rollback');
      await holder.end();
      const r = await foreign;
      // eslint-disable-next-line no-console
      console.log(`REV-M3b ajena-existente esperó el lock: ${waited} (resolvio ${r} a los ${settledAt}ms); inexistente: ${ghost} en ${ghostMs}ms`);
      expect(waited).toBe(true);
    });
  },
);
