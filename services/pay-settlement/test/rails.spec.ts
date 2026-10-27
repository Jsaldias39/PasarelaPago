import { RailAmbiguousError, RailUnavailableError } from '../src/settlement/errors';
import type { ConnectorsPort, PayoutOrder } from '../src/settlement/ports';
import { AcquirerSettlementRail, BankTransferRail } from '../src/settlement/rails';
import { FakeConnectors } from './helpers/fakes';

const order = (over: Partial<PayoutOrder> = {}): PayoutOrder => ({ payoutId: 'po_abcdefghijklmnop', mode: 'test', businessRef: 'po_abcdefghijklmnop:payout', attempt: 1, merchantId: 'mc_abcdefghijk', amountMinor: 5000, currency: 'BOB', ...over });

describe('AcquirerSettlementRail — [DOBLE] declarado del modo B (D-02, P2.H2.M3/M8)', () => {
  const rail = new AcquirerSettlementRail();

  it('se declara simulado y de modo B', () => {
    expect(rail.code).toBe('acquirer_settlement');
    expect(rail.simulated).toBe(true);
  });

  it('correcto: la orden se «paga» con una referencia reconocible como simulada', async () => {
    expect(await rail.send(order())).toEqual({ state: 'paid', reference: 'sim_po_abcdefghijklmnop' });
  });

  it('límite: 1 centavo y el mayor entero seguro se aceptan; repetir la orden da el mismo resultado', async () => {
    expect((await rail.send(order({ amountMinor: 1 }))).state).toBe('paid');
    expect((await rail.send(order({ amountMinor: Number.MAX_SAFE_INTEGER }))).state).toBe('paid');
    expect(await rail.send(order())).toEqual(await rail.send(order()));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])('inválido: el monto %p se rechaza sin «pagar»', async (amountMinor) => {
    expect(await rail.send(order({ amountMinor }))).toEqual({ state: 'failed', code: 'rail_rejected' });
  });

  it('la consulta responde siempre con la misma referencia simulada (nunca deja una orden en el aire)', async () => {
    expect(await rail.query(order())).toEqual({ state: 'paid', reference: 'sim_po_abcdefghijklmnop' });
  });
});

describe('BankTransferRail — riel real del modo A: delega en pay-connectors con clave estable', () => {
  it('correcto: ordena con la clave `payout-<id>` y consulta por la misma orden', async () => {
    const connectors = new FakeConnectors();
    const rail = new BankTransferRail(connectors);
    expect(rail.code).toBe('bank_transfer');
    expect(rail.simulated).toBe(false);
    expect(await rail.send(order())).toEqual({ state: 'paid', reference: 'tr_po_abcdefghijklmnop' });
    expect(connectors.orders[0].key).toBe('payout-po_abcdefghijklmnop');
    expect(await rail.query(order())).toEqual({ state: 'paid', reference: 'tr_po_abcdefghijklmnop' });
  });

  it('límite: reenviar la misma orden NO paga dos veces (idempotente) y en tránsito se confirma tarde', async () => {
    const connectors = new FakeConnectors();
    connectors.scenario = 'in_transit';
    const rail = new BankTransferRail(connectors);
    expect((await rail.send(order())).state).toBe('in_transit');
    expect((await rail.send(order())).state).toBe('in_transit');
    expect(connectors.executedCount).toBe(1);
    connectors.settle('po_abcdefghijklmnop');
    expect((await rail.query(order())).state).toBe('paid');
  });

  it('inválido/falla: sin efecto, rechazo, ambiguo y consulta de una orden desconocida se propagan sin convertirse en otra cosa', async () => {
    const connectors = new FakeConnectors();
    const rail = new BankTransferRail(connectors);
    connectors.scenario = 'unavailable';
    await expect(rail.send(order())).rejects.toBeInstanceOf(RailUnavailableError);
    connectors.scenario = 'ambiguous_lost';
    await expect(rail.send(order())).rejects.toBeInstanceOf(RailAmbiguousError);
    connectors.scenario = 'rejected';
    expect(await rail.send(order())).toEqual({ state: 'failed', code: 'rail_rejected' });
    expect(await rail.query(order({ payoutId: 'po_desconocidodesconoc' }))).toEqual({ state: 'not_found' });
  });

  it('no inventa estado: lo que el conector devuelve es lo que el riel devuelve', async () => {
    const stub: ConnectorsPort = { getStatement: async () => ({ format: 'json', lines: [] }), createTransfer: async () => ({ state: 'in_transit', reference: 'x' }), queryTransfer: async () => ({ state: 'not_found' }) };
    const rail = new BankTransferRail(stub);
    expect(await rail.send(order())).toEqual({ state: 'in_transit', reference: 'x' });
    expect(await rail.query(order())).toEqual({ state: 'not_found' });
  });
});
