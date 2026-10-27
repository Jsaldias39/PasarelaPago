import { jest } from '@jest/globals';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import { MockPumpService } from '../src/core/mock-pump.service';
import { PollerService } from '../src/core/poller.service';
import { REGISTRY } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';
import { until } from './support/process';

// Un cobro QR de importe normal (Bs 100,00 → centavos 00) termina cobrado (público `succeeded`, del proveedor `captured`) SIN banco real y SIN que la prueba empuje nada a mano:
// por el callback FIRMADO que entrega la bomba del simulador (temporizador real) y, aparte, por el poller de estado (temporizador real).
// Cada camino se prueba solo; el README (§ «Cobro de punta a punta sin banco real») dice cómo se dispara en el arnés.
const NORMAL_AMOUNT = 10000;
const POLLER = { intervalMs: 25, minAgeMs: 1_000, baseBackoffMs: 30_000, maxBackoffMs: 600_000, batchSize: 50 };

let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;
beforeAll(async () => {
  validateEvent = await loadEventValidator();
});

const statusOf = async (t: TestApp, id: string): Promise<string> => (await get(t.app, `/charges/${id}`)).body.status as string;
const waitSucceeded = async (t: TestApp, id: string): Promise<boolean> => {
  let lastError: unknown;
  const done = await until(async () => {
    try {
      return (await statusOf(t, id)) === 'succeeded' ? true : undefined;
    } catch (error) {
      lastError = error;
      return undefined;
    }
  }, 15_000);
  if (done) return true;
  const row = (await t.db.pool.query('SELECT provider_status, provider_reference, next_poll_at, poll_attempts FROM connector_charges WHERE id = $1', [id])).rows[0];
  throw new Error(`el cobro ${id} no llegó a succeeded; fila=${JSON.stringify(row)}; callbacks=${JSON.stringify(await callbackRows(t, id))}; último error=${String(lastError)}`);
};
const callbackRows = async (t: TestApp, id: string) => (await t.db.pool.query('SELECT status, result, observed_via FROM connector_callback_events WHERE charge_id = $1 ORDER BY id', [id])).rows;

describe('cobro QR de punta a punta sin banco real', () => {
  it('por callback firmado: la bomba del simulador (MOCK_PUMP_INTERVAL_MS) lo entrega sola y el cobro queda cobrado', async () => {
    const t = await createTestApp({ config: { mockPumpIntervalMs: 25, poller: { ...POLLER, intervalMs: 0 } } });
    try {
      const created = await post(t.app, '/charges', chargeBody({ amount_minor: NORMAL_AMOUNT }, t.clock), asPayments, uniqueKey());
      expect(created.status).toBe(201);
      // La bomba corre sola cada 25 ms: el callback puede llegar antes o después de que se arme esta respuesta (las dos son válidas).
      expect(['requires_action', 'succeeded']).toContain(created.body.status);
      if (created.body.status === 'requires_action') expect(created.body.next_action.type).toBe('display_qr');
      expect(await waitSucceeded(t, created.body.id)).toBe(true);
      // Llegó por el CALLBACK (verificado con la firma Standard Webhooks), no por consulta de estado.
      expect(await callbackRows(t, created.body.id)).toEqual([{ status: 'captured', result: 'applied', observed_via: 'callback' }]);
      const events = await outboxEvents(t.db.pool, 'connector.transaction.status_changed');
      expect(events).toHaveLength(1);
      expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
      expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'callback', amount_minor: NORMAL_AMOUNT, connector: 'mock' });
    } finally {
      await t.close();
    }
  });

  it('por polling: sin callbacks, el poller de estado (temporizador real) consulta al banco y el cobro queda cobrado', async () => {
    const t = await createTestApp({ config: { mockPumpIntervalMs: 0, poller: POLLER } });
    try {
      const created = await post(t.app, '/charges', chargeBody({ amount_minor: NORMAL_AMOUNT }, t.clock), asPayments, uniqueKey());
      expect(created.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 150)); // ventana: antes de cumplir `minAgeMs` el poller NO consulta
      expect(await statusOf(t, created.body.id)).toBe('requires_action');
      t.clock.advance(POLLER.minAgeMs + 1); // el reloj de las pruebas no corre solo: así el cobro cumple la edad mínima
      expect(await waitSucceeded(t, created.body.id)).toBe(true);
      const events = await outboxEvents(t.db.pool, 'connector.transaction.status_changed');
      expect(events).toHaveLength(1);
      expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'status_inquiry' });
      // El callback del banco quedó sin entregar (la bomba está apagada): cuando llega tarde, el cobro ya terminal lo absorbe sin duplicar nada.
      const late = await t.app.get(MockPumpService).tick();
      expect(late).toHaveLength(1);
      expect(late[0]?.result).not.toBe('applied');
      expect(await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).toHaveLength(1);
      expect(await statusOf(t, created.body.id)).toBe('succeeded');
    } finally {
      await t.close();
    }
  });

  it('control negativo: con la bomba y el poller apagados el cobro SIGUE sin cobrar (`requires_action`) (nada lo captura a escondidas)', async () => {
    const t = await createTestApp({ config: { mockPumpIntervalMs: 0, poller: { ...POLLER, intervalMs: 0 } } });
    try {
      const created = await post(t.app, '/charges', chargeBody({ amount_minor: NORMAL_AMOUNT }, t.clock), asPayments, uniqueKey());
      await new Promise((resolve) => setTimeout(resolve, 300)); // ventana para que, si algo lo capturara solo, se note
      expect(await statusOf(t, created.body.id)).toBe('requires_action');
      expect(await callbackRows(t, created.body.id)).toEqual([]);
      // A mano sí: confirma que el cobro era capturable y que lo que faltaba era el temporizador.
      expect((await t.app.get(MockPumpService).tick()).map((d) => d.result)).toEqual(['applied']);
      expect(await statusOf(t, created.body.id)).toBe('succeeded');
      expect(await t.app.get(PollerService).tick()).toEqual({ examined: 0, changed: 0, failed: 0 });
    } finally {
      await t.close();
    }
  });

  it('carrera real: el callback llega MIENTRAS el envío espera la respuesta del proveedor; la respuesta síncrona (`pending`) NO pisa el estado nuevo', async () => {
    // Hallada por la corrida con carga: el UPDATE posterior al envío ponía `provider_status = pending` aunque el callback ya hubiera aplicado `captured`.
    const t = await createTestApp({ config: { mockPumpIntervalMs: 0, poller: { ...POLLER, intervalMs: 0 } } });
    try {
      const mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
      const original = mock.createCharge.bind(mock);
      const pump = t.app.get(MockPumpService);
      let delivered: Array<{ result: string }> = [];
      // [DOBLE] El proveedor responde, y ANTES de que el servicio persista esa respuesta el banco entrega su callback firmado.
      jest.spyOn(mock, 'createCharge').mockImplementation(async (...args) => {
        const result = await original(...args);
        delivered = await pump.tick();
        return result;
      });
      const created = await post(t.app, '/charges', chargeBody({ amount_minor: NORMAL_AMOUNT }, t.clock), asPayments, uniqueKey());
      expect(created.status).toBe(201);
      expect(delivered.map((d) => d.result)).toEqual(['applied']); // el callback sí se aplicó antes de que el envío escribiera
      const row = (await t.db.pool.query('SELECT provider_status, provider_reference, ambiguous FROM connector_charges WHERE id = $1', [created.body.id])).rows[0];
      expect(row).toMatchObject({ provider_status: 'captured', ambiguous: false });
      expect(row.provider_reference).toMatch(/^SIM-/); // y la referencia del proveedor quedó guardada igual
      expect(created.body.status).toBe('succeeded');
      expect(await statusOf(t, created.body.id)).toBe('succeeded');
      expect(await callbackRows(t, created.body.id)).toEqual([{ status: 'captured', result: 'applied', observed_via: 'callback' }]);
      expect(await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).toHaveLength(1);
      // El poller no lo vuelve a tocar: ya es terminal.
      t.clock.advance(3_600_000);
      expect(await t.app.get(PollerService).tick()).toEqual({ examined: 0, changed: 0, failed: 0 });
    } finally {
      await t.close();
    }
  });
});
