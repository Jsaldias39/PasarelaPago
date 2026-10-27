import type { ConnectorsPort, PayoutOrder, PayoutRail, RailOutcome } from './ports';

/**
 * Riel REAL del modo A (D-02): transferencia desde la cuenta recaudadora, ordenada a `pay-connectors`.
 * La orden es idempotente por `payoutId` (clave de idempotencia estable): repetirla no paga dos veces.
 */
export class BankTransferRail implements PayoutRail {
  readonly code = 'bank_transfer' as const;
  readonly simulated = false;

  constructor(private readonly connectors: ConnectorsPort) {}

  send(order: PayoutOrder): Promise<RailOutcome> {
    return this.connectors.createTransfer(order, `payout-${order.payoutId}`);
  }

  query(order: PayoutOrder, reference: string | null): Promise<RailOutcome> {
    return this.connectors.queryTransfer(order, reference);
  }
}

/**
 * DOBLE DECLARADO del modo B (liquidación como adquirente). D-02 eligió el modo A: AloVida no es adquirente, así que este riel
 * existe solo para que `settlement.mode=acquirer` arranque y se pueda ejercitar. NO mueve dinero, NO habla con ningún banco, y
 * todo payout que pasa por acá queda marcado `simulated: true`. Se niega a correr con `PAY_MODE=live` (ver `loadSettlementConfig`).
 * Operarlo de verdad exige licencia y una decisión nueva.
 */
export class AcquirerSettlementRail implements PayoutRail {
  readonly code = 'acquirer_settlement' as const;
  readonly simulated = true;

  async send(order: PayoutOrder): Promise<RailOutcome> {
    if (!Number.isSafeInteger(order.amountMinor) || order.amountMinor < 1) return { state: 'failed', code: 'rail_rejected' };
    return { state: 'paid', reference: `sim_${order.payoutId}` };
  }

  async query(order: PayoutOrder, reference: string | null): Promise<RailOutcome> {
    // El doble nunca deja una orden sin respuesta: si no tiene referencia, nunca la recibió.
    if (reference !== `sim_${order.payoutId}`) return { state: 'not_found' };
    return { state: 'paid', reference };
  }
}
