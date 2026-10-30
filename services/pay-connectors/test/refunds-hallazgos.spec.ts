import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { MockPumpService, SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import { ConnectorTimeoutError, type ProviderRefundRequest, type ProviderRefundResult, type ProviderRefundStatusResult } from '../src/domain/connector';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';
import { outboxEvents } from './support/events';

/**
 * Hallazgos F4 y F6 de docs/trabajo/ola-5/integracion/revision/REVISION-DINERO.md (punto 1, reembolsos).
 * Datos sintéticos. El banco es el simulado (doble declarado); PostgreSQL es real.
 */
let t: TestApp;
let bank: SimulatedBank;
let pump: MockPumpService;
let connector: MockConnector;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  pump = t.app.get(MockPumpService);
  connector = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  bank.setDown(false);
});

const paid = async (amount = 10000): Promise<string> => {
  const created = await post(t.app, '/charges', chargeBody({ amount_minor: amount }, t.clock), asPayments, uniqueKey());
  await pump.tick();
  return created.body.id as string;
};
const refund = (chargeId: string, key: string, body: Record<string, unknown>) => post(t.app, `/charges/${chargeId}/refunds`, body, asPayments, key);
const rows = async () =>
  (await t.db.pool.query('SELECT id, refund_id, status, failure_code, may_have_reached_provider AS flag, send_claims AS claims, provider_reference, idempotency_key AS key FROM connector_refunds ORDER BY created_at, id')).rows as Array<Record<string, unknown>>;
const refundEvents = async () => (await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund');
/** Cuenta cuántas órdenes de reembolso llegaron al conector (doble declarado del proveedor). */
const countSends = (): { calls: ProviderRefundRequest[]; restore: () => void } => {
  const original = connector.refund.bind(connector);
  const calls: ProviderRefundRequest[] = [];
  connector.refund = async (request: ProviderRefundRequest, now: Date) => {
    calls.push(request);
    return original(request, now);
  };
  return { calls, restore: () => (connector.refund = original) };
};
const RE_X = 're_hallazgof4abc1';

describe('F4: reabrir un reembolso `failed` cuyo refund_id ya lo tomó OTRA clave (índice connector_refunds_refund_id_uidx)', () => {
  /** K1 queda `failed` (502 «sin efecto») y K2 con el MISMO refund_id lo crea y lo completa. */
  const k1FailedThenK2Succeeded = async (id: string, k1: string, k2: string) => {
    bank.setDown(true);
    expect((await refund(id, k1, { amount_minor: 5000, refund_id: RE_X })).status).toBe(502);
    bank.setDown(false);
    const second = await refund(id, k2, { amount_minor: 5000, refund_id: RE_X });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('succeeded');
    return second;
  };

  it('correcto: el reintento de K1 da 409 invalid_state_transition (contrato), determinista y repetible; K1 no se reabre, no se envía nada al banco y K2 queda intacto', async () => {
    const id = await paid();
    const k1 = uniqueKey();
    const k2 = uniqueKey();
    const second = await k1FailedThenK2Succeeded(id, k1, k2);
    const sends = countSends();
    try {
      const retry = await refund(id, k1, { amount_minor: 5000, refund_id: RE_X });
      expect([retry.status, retry.body.code]).toEqual([409, 'invalid_state_transition']);
      t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 409, body: retry.body });
      expect(retry.body.detail).toBe('Ya hay un reembolso con ese refund_id');
      // Otra vez la misma clave: la respuesta definitiva se repite tal cual (nunca un 500 ambiguo).
      const again = await refund(id, k1, { amount_minor: 5000, refund_id: RE_X });
      expect([again.status, again.body, again.headers['idempotency-replayed']]).toEqual([409, retry.body, 'true']);
      expect(sends.calls).toHaveLength(0); // jamás un segundo envío al banco
    } finally {
      sends.restore();
    }
    const stored = await rows();
    expect(stored).toHaveLength(2);
    // K1 sigue `failed` / sin efecto / sin referencia: la transacción de reapertura se deshizo entera (ni estado, ni código, ni reclamo).
    expect(stored.find((r) => r.key === k1)).toMatchObject({ refund_id: RE_X, status: 'failed', failure_code: 'connector_unavailable', flag: true, claims: 1, provider_reference: null });
    expect(stored.find((r) => r.key === k2)).toMatchObject({ refund_id: RE_X, status: 'succeeded' });
    expect(bank.refundStatus(second.body.id)).toMatchObject({ status: 'captured' });
    expect(await refundEvents()).toHaveLength(1); // solo el de K2
    expect((await t.db.pool.query("SELECT COALESCE(SUM(amount_minor), 0)::int AS n FROM connector_refunds WHERE status <> 'failed'")).rows[0].n).toBe(5000);
  });

  it('límite: si K2 quedó AMBIGUO (`pending`, también ocupa el índice) K1 sigue dando 409 y no toca a K2', async () => {
    const id = await paid();
    const k1 = uniqueKey();
    const k2 = uniqueKey();
    bank.setDown(true);
    expect((await refund(id, k1, { amount_minor: 5000, refund_id: RE_X })).status).toBe(502);
    bank.setDown(false);
    const original = connector.refund.bind(connector);
    connector.refund = async () => {
      throw new ConnectorTimeoutError();
    };
    try {
      expect((await refund(id, k2, { amount_minor: 5000, refund_id: RE_X })).status).toBe(500); // ambiguo: la fila queda `pending`
      const retry = await refund(id, k1, { amount_minor: 5000, refund_id: RE_X });
      expect([retry.status, retry.body.code]).toEqual([409, 'invalid_state_transition']);
    } finally {
      connector.refund = original;
    }
    const stored = await rows();
    expect(stored.find((r) => r.key === k1)).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable', claims: 1 });
    expect(stored.find((r) => r.key === k2)).toMatchObject({ status: 'pending', claims: 1 });
  });

  it('límite: si K2 con el mismo refund_id también quedó `failed` (el índice lo excluye) K1 SÍ se reabre y se completa: el 409 es solo para el choque real', async () => {
    const id = await paid();
    const k1 = uniqueKey();
    const k2 = uniqueKey();
    bank.setDown(true);
    expect((await refund(id, k1, { amount_minor: 5000, refund_id: RE_X })).status).toBe(502);
    expect((await refund(id, k2, { amount_minor: 5000, refund_id: RE_X })).status).toBe(502); // el índice no lo bloquea: K1 está `failed`
    bank.setDown(false);
    const retry = await refund(id, k1, { amount_minor: 5000, refund_id: RE_X });
    expect([retry.status, retry.body.status]).toEqual([201, 'succeeded']);
    // K2 ahora es el que choca al reabrirse: la misma regla, simétrica.
    const other = await refund(id, k2, { amount_minor: 5000, refund_id: RE_X });
    expect([other.status, other.body.code]).toEqual([409, 'invalid_state_transition']);
    expect((await rows()).filter((r) => r.status === 'succeeded')).toHaveLength(1);
  });

  it('límite: sin refund_id (nulo) no hay índice que choque: K1 se reabre aunque exista otro reembolso igual', async () => {
    const id = await paid();
    const k1 = uniqueKey();
    bank.setDown(true);
    expect((await refund(id, k1, { amount_minor: 5000 })).status).toBe(502);
    bank.setDown(false);
    expect((await refund(id, uniqueKey(), { amount_minor: 5000 })).status).toBe(201);
    const retry = await refund(id, k1, { amount_minor: 5000 });
    expect([retry.status, retry.body.status]).toEqual([201, 'succeeded']);
  });

  it('inválido: la misma clave K1 con OTRO cuerpo sigue siendo 422 idempotency_key_reused y no toca nada', async () => {
    const id = await paid();
    const k1 = uniqueKey();
    await k1FailedThenK2Succeeded(id, k1, uniqueKey());
    const before = await rows();
    const reused = await refund(id, k1, { amount_minor: 4000, refund_id: RE_X });
    expect([reused.status, reused.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect(await rows()).toEqual(before);
  });

  it.each([1, 2, 3, 4, 5, 6])('corrida %i: K1 (reabre) y K2 (nuevo) con el MISMO refund_id a la vez ⇒ exactamente uno prospera, el otro 409, ningún 500 y el banco recibe UNA sola orden', async () => {
    await t.reset();
    const id = await paid();
    const k1 = uniqueKey();
    const k2 = uniqueKey();
    bank.setDown(true);
    expect((await refund(id, k1, { amount_minor: 5000, refund_id: RE_X })).status).toBe(502);
    bank.setDown(false);
    const sends = countSends();
    let responses;
    try {
      responses = await Promise.all([refund(id, k1, { amount_minor: 5000, refund_id: RE_X }), refund(id, k2, { amount_minor: 5000, refund_id: RE_X })]);
    } finally {
      sends.restore();
    }
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)?.body.code).toBe('invalid_state_transition');
    expect(sends.calls).toHaveLength(1); // jamás dos órdenes para el mismo refund_id
    const stored = await rows();
    expect(stored.filter((r) => r.status === 'succeeded')).toHaveLength(1);
    expect(stored.filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(await refundEvents()).toHaveLength(1);
  });
});

describe('F6: `connector_unavailable` como código del PROVEEDOR no se confunde con el centinela interno «sin efecto»', () => {
  /** Un reembolso queda ambiguo (`pending`, timeout) y después la consulta autoritativa trae un `failed` del proveedor con el código del centinela. */
  const ambiguousThenProviderFailed = async (providerCode: string) => {
    const id = await paid();
    const key = uniqueKey();
    const original = connector.refund.bind(connector);
    connector.refund = async () => {
      throw new ConnectorTimeoutError();
    };
    let first;
    try {
      first = await refund(id, key, { amount_minor: 10000 });
    } finally {
      connector.refund = original;
    }
    expect([first.status, first.body.code]).toEqual([500, 'internal_error']);
    const crId = (await rows())[0]!.id as string;
    const originalGet = connector.getRefund!.bind(connector);
    connector.getRefund = async (): Promise<ProviderRefundStatusResult> => ({ status: 'failed', providerReference: 'SIM-R-PROV1', failureCode: providerCode });
    try {
      const observed = await get(t.app, `/refunds/${crId}?refresh=true`);
      expect(observed.status).toBe(200);
      return { id, key, crId, observed: observed.body as Record<string, unknown> };
    } finally {
      connector.getRefund = originalGet;
    }
  };

  it('correcto: el proveedor responde `failed` con código connector_unavailable Y referencia ⇒ es terminal: el reintento no reabre, no reenvía, y no se anuncia dos veces', async () => {
    const { id, key, crId, observed } = await ambiguousThenProviderFailed('connector_unavailable');
    expect(await refundEvents()).toHaveLength(1);
    const sends = countSends();
    try {
      const retry = await refund(id, key, { amount_minor: 10000 });
      expect([retry.status, retry.body.status, retry.body.id]).toEqual([201, 'failed', crId]);
      expect(sends.calls).toHaveLength(0); // no se reenvió
    } finally {
      sends.restore();
    }
    expect(observed).toMatchObject({ status: 'failed', failure_code: 'rejected_by_provider' }); // el código del proveedor ya no es el centinela
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', failure_code: 'rejected_by_provider', provider_reference: 'SIM-R-PROV1', claims: 1 })]);
    expect(await refundEvents()).toHaveLength(1); // ningún `refund:<id>:failed` repetido
    expect(bank.refundStatus(crId)).toMatchObject({ status: 'not_found' }); // el banco nunca recibió una segunda orden
  });

  it('correcto: también por el camino directo del POST: un `failed` del proveedor con ese código sale como failed/rejected_by_provider (201) y el evento NO anuncia «sin efecto»', async () => {
    const id = await paid();
    const original = connector.refund.bind(connector);
    connector.refund = async (): Promise<ProviderRefundResult> => ({ status: 'failed', providerReference: 'SIM-R-PROV2', failureCode: 'connector_unavailable' });
    try {
      const response = await refund(id, uniqueKey(), { amount_minor: 10000 });
      expect([response.status, response.body.status, response.body.failure_code]).toEqual([201, 'failed', 'rejected_by_provider']);
      t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 201, body: response.body });
    } finally {
      connector.refund = original;
    }
    const events = await refundEvents();
    expect(events).toHaveLength(1);
    // El evento solo admite 4 códigos (AsyncAPI); `eventFailureCode` manda el resto a `validation_failed`. Lo importante: NO sale `connector_unavailable`
    // (que para los consumidores significa «el conector garantiza que no se envió nada»), porque aquí el proveedor SÍ respondió, con referencia.
    expect((events[0]!.envelope.data as Record<string, unknown>).failure_code).toBe('validation_failed');
  });

  it('límite: cualquier OTRO código del proveedor se conserva tal cual y también es terminal', async () => {
    const { id, key, observed } = await ambiguousThenProviderFailed('rejected_by_bank');
    expect(observed).toMatchObject({ status: 'failed', failure_code: 'rejected_by_bank' });
    const sends = countSends();
    try {
      const retry = await refund(id, key, { amount_minor: 10000 });
      expect([retry.status, retry.body.status, retry.body.failure_code]).toEqual([201, 'failed', 'rejected_by_bank']);
      expect(sends.calls).toHaveLength(0);
    } finally {
      sends.restore();
    }
  });

  it('inválido: el centinela interno NO cambia hacia afuera (proveedor caído ⇒ 502 connector_unavailable, fila failed/connector_unavailable sin referencia) y su reintento sigue reenviándose', async () => {
    const id = await paid();
    const key = uniqueKey();
    bank.setDown(true);
    const down = await refund(id, key, { amount_minor: 10000 });
    expect([down.status, down.body.code]).toEqual([502, 'connector_unavailable']);
    t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 502, body: down.body });
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', failure_code: 'connector_unavailable', provider_reference: null })]);
    bank.setDown(false);
    const sends = countSends();
    try {
      const retry = await refund(id, key, { amount_minor: 10000 });
      expect([retry.status, retry.body.status]).toEqual([201, 'succeeded']);
      expect(sends.calls).toHaveLength(1); // provenUnsent intacto: lo probado «sin efecto» sí se reenvía
    } finally {
      sends.restore();
    }
  });
});
