import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError } from '../../domain/connector';
import type { Method, ProviderRefundResult, ProviderStatus, StatementLine } from '../../domain/connector';
import { scenarioFor, seededRandom, type Scenario } from './scenarios';

/**
 * [DOBLE] Banco simulado en memoria. NO es el Banco Mercantil ni se parece a su API (que no conocemos): solo ejercita los caminos
 * que cualquier proveedor real tendría — éxito, rechazo, demora, duplicado, reorden, pérdida, caída y timeout ambiguo.
 * Idempotente por `reference`, como se le exige a un proveedor real.
 */
interface SimCharge {
  readonly reference: string;
  readonly providerReference: string;
  readonly amountMinor: bigint;
  readonly method: Method;
  readonly scenario: Scenario;
  readonly expiresAt: Date;
  /** Instante en que el pagador «paga»; `null` si nunca. */
  readonly paidAt: Date | null;
  canceled: boolean;
  timedOutOnce: boolean;
  readonly refunds: Map<string, { providerReference: string; amountMinor: bigint }>;
}

export interface ScheduledCallback {
  readonly dueAt: Date;
  readonly eventId: string;
  readonly reference: string;
  readonly status: ProviderStatus;
  readonly occurredAt: Date;
  readonly amountMinor: bigint;
  readonly failureCode?: string;
}

export class SimulatedBank {
  private readonly charges = new Map<string, SimCharge>();
  private callbacks: ScheduledCallback[] = [];
  private readonly extraLines: StatementLine[] = [];
  private readonly random: () => number;
  private seq = 0;
  private down = false;

  constructor(private readonly options: { seed?: number; delayMs?: number } = {}) {
    this.random = seededRandom(options.seed ?? 1);
  }

  /** Apaga o prende todo el banco (para probar salud y ruteo). */
  setDown(value: boolean): void {
    this.down = value;
  }

  isDown(): boolean {
    return this.down;
  }

  private eventId(): string {
    return `evt_${Math.floor(this.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  }

  private schedule(callback: Omit<ScheduledCallback, 'eventId'> & { eventId?: string }): ScheduledCallback {
    const full = { ...callback, eventId: callback.eventId ?? this.eventId() };
    this.callbacks.push(full);
    return full;
  }

  charge(input: { reference: string; amountMinor: bigint; method: Method; expiresAt: Date }, now: Date): { providerReference: string; status: ProviderStatus; failureCode?: string } {
    if (this.down) throw new ConnectorUnavailableError('unreachable');
    const existing = this.charges.get(input.reference);
    if (existing) return { providerReference: existing.providerReference, status: this.statusOf(existing, now) };

    const scenario = scenarioFor(input.amountMinor);
    if (scenario === 'down') throw new ConnectorUnavailableError('unreachable');

    this.seq += 1;
    const paidAt = scenario === 'never_paid' || scenario === 'declined' ? null : scenario === 'delayed' ? new Date(now.getTime() + (this.options.delayMs ?? 5000)) : now;
    const charge: SimCharge = {
      reference: input.reference,
      providerReference: `SIM-${String(this.seq).padStart(6, '0')}`,
      amountMinor: input.amountMinor,
      method: input.method,
      scenario,
      expiresAt: input.expiresAt,
      paidAt,
      canceled: false,
      timedOutOnce: false,
      refunds: new Map(),
    };
    this.charges.set(input.reference, charge);

    const base = { reference: input.reference, amountMinor: input.amountMinor };
    switch (scenario) {
      case 'approved':
      case 'statement_mismatch':
      case 'ambiguous_timeout':
        this.schedule({ ...base, dueAt: now, status: 'captured', occurredAt: now });
        break;
      case 'delayed':
        this.schedule({ ...base, dueAt: paidAt as Date, status: 'captured', occurredAt: paidAt as Date });
        break;
      case 'duplicate_callback': {
        const first = this.schedule({ ...base, dueAt: now, status: 'captured', occurredAt: now });
        this.schedule({ ...first });
        this.schedule({ ...first });
        break;
      }
      case 'out_of_order': {
        // Primero llega el hecho POSTERIOR (captured) y después el anterior (authorized).
        this.schedule({ ...base, dueAt: now, status: 'captured', occurredAt: new Date(now.getTime() + 1000) });
        this.schedule({ ...base, dueAt: now, status: 'authorized', occurredAt: now });
        break;
      }
      case 'declined':
        return { providerReference: charge.providerReference, status: 'failed', failureCode: 'card_declined' };
      case 'lost_callback':
      case 'never_paid':
        break;
    }
    if (scenario === 'ambiguous_timeout') {
      charge.timedOutOnce = true; // el cobro existe, pero esta respuesta se pierde
      throw new ConnectorTimeoutError();
    }
    return { providerReference: charge.providerReference, status: 'pending' };
  }

  private statusOf(charge: SimCharge, now: Date): ProviderStatus {
    if (charge.scenario === 'declined') return 'failed';
    if (charge.canceled) return 'canceled';
    if (charge.paidAt && now.getTime() >= charge.paidAt.getTime()) return 'captured';
    if (now.getTime() >= charge.expiresAt.getTime()) return 'expired';
    return 'pending';
  }

  status(reference: string, now: Date): { status: ProviderStatus; failureCode?: string; occurredAt: Date } {
    if (this.down) throw new ConnectorUnavailableError('unreachable');
    const charge = this.charges.get(reference);
    if (!charge) throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    const status = this.statusOf(charge, now);
    return { status, ...(status === 'failed' ? { failureCode: 'card_declined' } : {}), occurredAt: status === 'captured' ? (charge.paidAt as Date) : status === 'expired' ? charge.expiresAt : now };
  }

  cancel(reference: string, now: Date): ProviderStatus {
    if (this.down) throw new ConnectorUnavailableError('unreachable');
    const charge = this.charges.get(reference);
    if (!charge) throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    const status = this.statusOf(charge, now);
    if (status === 'canceled') return 'canceled';
    if (status !== 'pending') throw new ConnectorRejectedError('invalid_state_transition');
    charge.canceled = true;
    return 'canceled';
  }

  refund(input: { reference: string; chargeReference: string; amountMinor: bigint }, now: Date): ProviderRefundResult {
    if (this.down) throw new ConnectorUnavailableError('unreachable');
    const charge = this.charges.get(input.chargeReference);
    if (!charge) throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    const previous = charge.refunds.get(input.reference);
    if (previous) return { providerReference: previous.providerReference, status: 'captured' };
    if (this.statusOf(charge, now) !== 'captured') throw new ConnectorRejectedError('invalid_state_transition');
    const refunded = [...charge.refunds.values()].reduce((sum, r) => sum + r.amountMinor, 0n);
    if (refunded + input.amountMinor > charge.amountMinor) {
      return { providerReference: `SIM-R-${charge.refunds.size + 1}`, status: 'failed', failureCode: 'validation_failed' };
    }
    const providerReference = `SIM-R-${String(++this.seq).padStart(6, '0')}`;
    charge.refunds.set(input.reference, { providerReference, amountMinor: input.amountMinor });
    return { providerReference, status: 'captured' };
  }

  /** Entrega pendiente cuyo momento ya llegó, en el orden en que se programó. Las saca de la cola. */
  dueCallbacks(now: Date): ScheduledCallback[] {
    const due = this.callbacks.filter((c) => c.dueAt.getTime() <= now.getTime());
    this.callbacks = this.callbacks.filter((c) => c.dueAt.getTime() > now.getTime());
    return due;
  }

  /** Agrega una línea al extracto que NO corresponde a ningún cobro nuestro (por ejemplo, un depósito sin referencia). */
  injectStatementLine(line: StatementLine): void {
    this.extraLines.push(line);
  }

  statement(range: { from: Date; to: Date }): StatementLine[] {
    const lines: StatementLine[] = [];
    for (const charge of this.charges.values()) {
      if (!charge.paidAt || charge.paidAt < range.from || charge.paidAt > range.to) continue;
      // El escenario `statement_mismatch` informa Bs 1,00 menos que lo cobrado.
      const booked = charge.scenario === 'statement_mismatch' ? charge.amountMinor - 100n : charge.amountMinor;
      lines.push({ providerReference: `${charge.providerReference}-L`, ourReference: charge.reference, direction: 'credit', amountMinor: booked, currency: 'BOB', valueDate: charge.paidAt.toISOString().slice(0, 10), bookedAt: charge.paidAt, description: 'ABONO SIMULADO' });
    }
    for (const line of this.extraLines) {
      const at = line.bookedAt ?? new Date(`${line.valueDate}T00:00:00Z`);
      if (at >= range.from && at <= range.to) lines.push(line);
    }
    return lines.sort((a, b) => (b.bookedAt?.getTime() ?? 0) - (a.bookedAt?.getTime() ?? 0) || (a.providerReference < b.providerReference ? 1 : -1));
  }
}
