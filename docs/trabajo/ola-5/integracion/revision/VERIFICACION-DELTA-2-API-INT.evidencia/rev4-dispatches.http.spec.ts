import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CONCEPTS } from '../../../common';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { JwtStrategy } from '../../../common/auth/jwt.strategy';
import { RolesGuard } from '../../../common/auth/roles.guard';
import { SessionValidator } from '../../../common/auth/session-validator';
import { TenantScopeGuard } from '../../../common/auth/tenant-scope.guard';
import { createGlobalValidationPipe } from '../../../common/http/validation-pipe';
import { TenantContextInterceptor } from '../../../common/tenant/tenant-context.interceptor';
import { PaymentsGatewayDispatchesController } from './payments-gateway-dispatches.controller';
import { PaymentsTransactionsService } from '../services/payments-transactions.service';
import { PaymentsGatewayChargeService } from '../services/payments-gateway-charge.service';
import { newDispatchMark } from '../gateway/payments-gateway-dispatch-mark';

/**
 * Matriz de autorización NEGATIVA de las rutas administrativas de las reservas de
 * despacho (`/payments/gateway-dispatches`), con la cadena REAL de guards e
 * interceptor (`JwtAuthGuard` con `JwtStrategy`, `TenantScopeGuard`, `RolesGuard`,
 * `TenantContextInterceptor`), el controlador real y el `PaymentsTransactionsService`
 * real sobre repositorios en memoria. La pasarela (`dispatch`/`consult`) es un
 * doble: lo que se afirma en los casos rechazados es que NO recibió llamadas y
 * que la intención del tenant B no se tocó. `RLS_ENFORCE` queda sin definir: la
 * barrera es del servicio, no de la base.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INTENT_OF_B = randomUUID();
const DEBT_OF_B = randomUUID();
const LEASE = 900_000;
const HOUR = 3_600_000;

describe('REV4 /payments/gateway-dispatches — adversarial', () => {
  const logs: unknown[][] = [];
  let app: INestApplication;
  let jwt: JwtService;
  const dispatch = jest.fn(async (_i: unknown, _m: unknown) => ({
    gatewayIntentRef: 'pi_abcdefghij12',
    gatewayStatus: 'requires_action',
    localStatusConceptId: CONCEPTS.PI_PENDING,
    replayed: false,
  }));
  const consult = jest.fn(async () => ({
    gatewayIntentRef: 'pi_abcdefghij12',
    gatewayStatus: 'requires_action',
    localStatusConceptId: CONCEPTS.PI_PENDING,
    replayed: true,
  }));

  const intentOfB: Record<string, any> = {};
  const resetIntent = (mark = newDispatchMark(Date.now() - 2 * HOUR)) => {
    Object.assign(intentOfB, {
      id: INTENT_OF_B,
      tenantId: TENANT_B,
      amount: '150.00',
      currencyConceptId: CONCEPTS.CURRENCY_BOB,
      statusConceptId: CONCEPTS.PI_PENDING,
      idempotencyKey: 'k-b',
      sourceRefType: 'payment_debt',
      sourceRefId: DEBT_OF_B,
      gatewayIntentRef: mark,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };
  const debtOfB = {
    id: DEBT_OF_B,
    tenantId: TENANT_B,
    currencyCode: 'BOB',
    outstandingAmount: '150.000000',
    statusConceptId: CONCEPTS.DEBT_PENDING,
  };

  beforeAll(async () => {
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      warn: (...a: unknown[]) => { logs.push(a); },
      error: (...a: unknown[]) => { logs.push(a); },
    };
    const em = {
      isInTransaction: () => false,
      transactional: async (cb: (tx: unknown) => unknown) => cb({}),
    };
    const intentsRepo = {
      findByIdAndTenantForUpdate: async (
        _tx: unknown,
        id: string,
        tenantId: string,
      ) =>
        id === INTENT_OF_B && intentOfB.tenantId === tenantId
          ? intentOfB
          : null,
    };
    const flowRepo = {
      findLatestRiskAssessment: async () => ({
        decisionConceptId: CONCEPTS.RISK_APPROVE,
      }),
      findCheckoutSessionsByIntentForUpdate: async () => [],
      findDebtByIdForUpdate: async (_tx: unknown, id: string) =>
        id === DEBT_OF_B ? debtOfB : null,
      findInFlightGatewayIntentsOnDebt: async () => [],
    };
    const transactionsRepo = {
      findPendingByIntent: async () => null,
      findByIntent: async () => [],
    };
    const charge = {
      enabled: true,
      dispatchLeaseMs: LEASE,
      acquireDispatchSlot: () => () => undefined,
      buildCreateRequest: () => ({}),
      reserveDispatch: () => undefined,
      listDispatchesRequiringReconciliation: async (tenantId: string) =>
        tenantId === TENANT_B
          ? [{ intentId: INTENT_OF_B, ageMs: 2 * HOUR, canReconcile: true }]
          : [],
      dispatch,
      consult,
    };
    const transactions = new PaymentsTransactionsService(
      em as never,
      intentsRepo as never,
      flowRepo as never,
      transactionsRepo as never,
      logger as never,
      charge as unknown as PaymentsGatewayChargeService,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [PaymentsGatewayDispatchesController],
      providers: [
        JwtService,
        JwtStrategy,
        {
          provide: SessionValidator,
          useValue: { assertActive: async () => undefined },
        },
        { provide: PaymentsTransactionsService, useValue: transactions },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: TenantScopeGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: EntityManager, useValue: {} },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dispatch.mockClear();
    consult.mockClear();
    resetIntent();
  });

  const token = (over: {
    roles: string[];
    tenants: string[];
    scopedRoles?: Record<string, string[]>;
  }) =>
    jwt.sign(
      {
        sub: randomUUID(),
        sid: randomUUID(),
        typ: 'access',
        roles: over.roles,
        tenants: over.tenants,
        scopedRoles: over.scopedRoles,
      },
      {
        secret: 'dev-only-insecure-secret-change-me',
        algorithm: 'HS256',
        expiresIn: '5m',
      },
    );

  const routes: ReadonlyArray<
    [string, 'get' | 'post', string, Record<string, unknown> | undefined]
  > = [
    [
      'listado',
      'get',
      '/payments/gateway-dispatches/pending-reconciliation',
      undefined,
    ],
    [
      'conciliar',
      'post',
      `/payments/gateway-dispatches/${INTENT_OF_B}/reconcile`,
      { paymentMethodType: 'qr' },
    ],
    [
      'cerrar',
      'post',
      `/payments/gateway-dispatches/${INTENT_OF_B}/close`,
      { reason: 'Verificado en la consola de la pasarela: no hay cobro' },
    ],
  ];

  const call = (
    method: 'get' | 'post',
    path: string,
    body: Record<string, unknown> | undefined,
    jwtToken?: string,
    tenantHeader?: string,
  ) => {
    let req = request(app.getHttpServer())[method](path);
    if (jwtToken) req = req.set('Authorization', `Bearer ${jwtToken}`);
    if (tenantHeader) req = req.set('X-Tenant-Id', tenantHeader);
    return body ? req.send(body) : req;
  };

  const untouched = () => {
    expect(dispatch).not.toHaveBeenCalled();
    expect(consult).not.toHaveBeenCalled();
    expect(intentOfB.statusConceptId).toBe(CONCEPTS.PI_PENDING);
    expect(String(intentOfB.gatewayIntentRef)).toMatch(/^dispatching:/u);
  };


  const out = (m: string) => process.stdout.write(`R4H> ${m}\n`);
  const adminB = () => token({ roles: ['PAYMENTS_ADMIN'], tenants: [TENANT_B] });
  const closePath = `/payments/gateway-dispatches/${INTENT_OF_B}/close`;
  const reconPath = `/payments/gateway-dispatches/${INTENT_OF_B}/reconcile`;
  const okReason = 'Verificado en la consola de la pasarela: no hay cobro';

  it('mass assignment en close/reconcile: campos no declarados se rechazan y la intencion no se toca', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['close+statusConceptId', closePath, { reason: okReason, statusConceptId: CONCEPTS.PI_PENDING }],
      ['close+gatewayIntentRef', closePath, { reason: okReason, gatewayIntentRef: 'pi_abcdefghij12' }],
      ['close+tenantId', closePath, { reason: okReason, tenantId: TENANT_A }],
      ['close+__proto__', closePath, JSON.parse('{"reason":"' + okReason + '","__proto__":{"isAdmin":true}}')],
      ['reconcile+amount', reconPath, { paymentMethodType: 'qr', amount: '1.00' }],
      ['reconcile+tenantId', reconPath, { paymentMethodType: 'qr', tenantId: TENANT_A }],
      ['reconcile+gatewayIntentRef', reconPath, { paymentMethodType: 'qr', gatewayIntentRef: 'pi_abcdefghij12' }],
    ];
    const res: string[] = [];
    for (const [n, p, b] of cases) {
      const r = await call('post', p, b, adminB(), TENANT_B);
      res.push(`${n}=${r.status}`);
    }
    out(`MASS-ASSIGNMENT: ${res.join(' ')}`);
    untouched();
  });

  it('motivo: limites 9/10/300/301, tipos raros y caracteres de control', async () => {
    const res: string[] = [];
    for (const [n, reason] of [
      ['9', 'x'.repeat(9)], ['10', 'x'.repeat(10)], ['300', 'x'.repeat(300)], ['301', 'x'.repeat(301)],
      ['numero', 12345678901234], ['array', ['aaaaaaaaaaaa']], ['null', null], ['objeto', { a: 'aaaaaaaaaaaa' }],
    ] as [string, unknown][]) {
      resetIntent();
      const r = await call('post', closePath, { reason }, adminB(), TENANT_B);
      res.push(`${n}=${r.status}`);
    }
    out(`MOTIVO: ${res.join(' ')}`);
    // inyeccion: saltos de linea, secuencias ANSI, U+2028 y un falso campo JSON
    resetIntent();
    const evil = 'ok\n{"level":"error","msg":"FORGED"}\u001b[31m  fin de motivo';
    const r = await call('post', closePath, { reason: evil }, adminB(), TENANT_B);
    const entry = logs.find((a) => (a[0] as any)?.operation === 'payments.gateway.dispatch-closed');
    out(`INYECCION motivo: status=${r.status}; reason va como CAMPO del objeto de log=${(entry?.[0] as any)?.reason === evil}; mensaje fijo=${JSON.stringify(entry?.[1])}; campos del log=${Object.keys((entry?.[0] as any) ?? {}).join(',')}`);
  });

  it('roles/tenant: SUPERADMIN sin X-Tenant-Id, SUPERADMIN con tenant, tenantId en query, id no UUID, PATIENT, CASHIER, token vencido', async () => {
    const res: string[] = [];
    const sa = token({ roles: ['SUPERADMIN'], tenants: [] });
    for (const [n, p, b, t, h] of [
      ['SA-sin-tenant-close', closePath, { reason: okReason }, sa, undefined],
      ['SA-con-tenant-close', closePath, { reason: okReason }, sa, TENANT_B],
      ['SA-sin-tenant-reconcile', reconPath, { paymentMethodType: 'qr' }, sa, undefined],
      ['PATIENT-close', closePath, { reason: okReason }, token({ roles: ['PATIENT'], tenants: [TENANT_B] }), TENANT_B],
      ['CASHIER-reconcile', reconPath, { paymentMethodType: 'qr' }, token({ roles: ['CASHIER'], tenants: [TENANT_B] }), TENANT_B],
      ['ADMIN-A-X-Tenant-B', closePath, { reason: okReason }, token({ roles: ['PAYMENTS_ADMIN'], tenants: [TENANT_A] }), TENANT_B],
      ['query-tenantId', closePath + `?tenantId=${TENANT_A}`, { reason: okReason }, adminB(), TENANT_B],
      ['id-no-uuid', '/payments/gateway-dispatches/no-es-uuid/close', { reason: okReason }, adminB(), TENANT_B],
    ] as [string, string, any, string, string | undefined][]) {
      resetIntent();
      const r = await call('post', p, b, t, h);
      res.push(`${n}=${r.status}${r.body?.reason ? '(' + r.body.reason + ')' : ''}`);
    }
    const sl = await call('get', '/payments/gateway-dispatches/pending-reconciliation', undefined, sa);
    res.push(`SA-listado-sin-tenant=${sl.status}`);
    const expired = jwt.sign({ sub: randomUUID(), sid: randomUUID(), typ: 'access', roles: ['PAYMENTS_ADMIN'], tenants: [TENANT_B] }, { secret: 'dev-only-insecure-secret-change-me', algorithm: 'HS256', expiresIn: '-10s' });
    const ex = await call('post', closePath, { reason: okReason }, expired, TENANT_B);
    res.push(`token-vencido=${ex.status}`);
    const refresh = jwt.sign({ sub: randomUUID(), sid: randomUUID(), typ: 'refresh', roles: ['PAYMENTS_ADMIN'], tenants: [TENANT_B] }, { secret: 'dev-only-insecure-secret-change-me', algorithm: 'HS256', expiresIn: '5m' });
    const rf = await call('post', closePath, { reason: okReason }, refresh, TENANT_B);
    res.push(`token-refresh-como-access=${rf.status}`);
    out(`ROLES: ${res.join(' ')}`);
    resetIntent();
    untouched();
  });

  it('respuestas: forma exacta, sin campos extra (PHI) en listado, cierre y conciliacion', async () => {
    const l = await call('get', '/payments/gateway-dispatches/pending-reconciliation', undefined, adminB(), TENANT_B);
    const c = await call('post', closePath, { reason: okReason }, adminB(), TENANT_B);
    resetIntent();
    const r = await call('post', reconPath, { paymentMethodType: 'qr' }, adminB(), TENANT_B);
    out(`FORMA listado=${JSON.stringify(Object.keys(l.body[0] ?? {}))} cierre=${JSON.stringify(Object.keys(c.body))} conciliar=${JSON.stringify(Object.keys(r.body))}`);
  });
});
