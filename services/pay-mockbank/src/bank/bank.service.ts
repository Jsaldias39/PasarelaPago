import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import type { Pool, PoolClient } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { CLOCK, type Clock } from '../clock';
import { PG_POOL } from '../database.module';
import { BankProblem, BankProxyHtml, BankSocketCut } from './faults';
import { scenarioFor, transferAmbiguity, type Scenario } from './scenarios';

export type Method = 'qr' | 'card' | 'bank_transfer';
/** Cuenta del extracto: `collections` (cobros QR/tarjeta) o `transfers` (depósitos del pagador). Sin cuenta: todas. */
export type StatementAccount = 'collections' | 'transfers';
export type BankStatus = 'pending' | 'authorized' | 'captured' | 'failed' | 'canceled' | 'expired';

interface ChargeRow {
  reference: string;
  bank_reference: string;
  method: Method;
  amount_minor: string;
  scenario: Scenario;
  expires_at: Date;
  paid_at: Date | null;
  canceled: boolean;
  qr_payload: string | null;
  awaits_payer: boolean;
}

export interface ChargeView {
  readonly bankReference: string;
  readonly status: BankStatus;
  readonly failureCode?: string;
  readonly occurredAt: Date;
}

export interface StatementEntry {
  readonly bankReference: string;
  readonly ourReference: string | null;
  readonly direction: 'credit' | 'debit';
  readonly amountMinor: bigint;
  readonly valueDate: string;
  readonly bookedAt: Date;
  readonly description: string | null;
}

/** Dos arranques del mismo `event_id`: el id es una función de lo que se informa, no de un azar (reproducible). */
export function eventIdFor(reference: string, status: string, ordinal: number): string {
  return `evt_${createHash('sha256').update(`${reference}|${status}|${ordinal}`).digest('hex').slice(0, 16)}`;
}

/**
 * [DOBLE] El banco simulado. NO es el Banco Mercantil ni se parece a su API (que no conocemos: Q-01, Q-11): ejercita los caminos que
 * cualquier banco real tendría. Idempotente por `reference`, como se le exige a un proveedor real. Todo en la base propia.
 */
@Injectable()
export class BankService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
  ) {}

  async isDown(): Promise<boolean> {
    return (await this.pool.query('SELECT down FROM mb_switches WHERE id = 1')).rows[0].down as boolean;
  }

  async setDown(down: boolean): Promise<void> {
    await this.pool.query('UPDATE mb_switches SET down = $1 WHERE id = 1', [down]);
  }

  /** 503 `bank_unavailable` si el banco está «caído». Lo usa la sonda de salud. */
  async ensureUp(): Promise<void> {
    return this.assertUp();
  }

  private async assertUp(): Promise<void> {
    if (await this.isDown()) throw new BankProblem(503, 'bank_unavailable');
  }

  /** Vuelve al estado inicial (sin cobros, callbacks ni líneas, conectado). */
  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE mb_callbacks, mb_refunds, mb_charges, mb_transfers, mb_card_auths, mb_statement_extra RESTART IDENTITY CASCADE');
    await this.pool.query('UPDATE mb_switches SET down = false WHERE id = 1');
  }

  private async nextBankReference(prefix: string): Promise<string> {
    const n = (await this.pool.query("SELECT nextval('mb_bank_seq')::int AS n")).rows[0].n as number;
    return `${prefix}-${String(n).padStart(6, '0')}`;
  }

  // ───────────────────────────── cobros (QR / tarjeta de un paso / transferencia entrante) ─────────────────────────────

  async createCharge(input: { reference: string; amountMinor: bigint; method: Method; expiresAt: Date }): Promise<{ view: ChargeView; created: boolean }> {
    await this.assertUp();
    const now = this.clock.now();
    const existing = await this.findCharge(input.reference);
    if (existing) return { view: this.view(existing, now), created: false };

    const scenario = scenarioFor(input.amountMinor);
    if (scenario === 'down') throw new BankProblem(503, 'bank_unavailable');

    const bankReference = await this.nextBankReference('SIM');
    const awaitsPayer = this.config.payerMode === 'manual' && input.method === 'qr' && scenario !== 'declined' && scenario !== 'never_paid';
    const inserted = await this.pool.query(
      `INSERT INTO mb_charges (reference, bank_reference, method, amount_minor, currency, scenario, expires_at, awaits_payer, created_at)
       VALUES ($1, $2, $3, $4, 'BOB', $5, $6, $7, $8) ON CONFLICT (reference) DO NOTHING RETURNING *`,
      [input.reference, bankReference, input.method, input.amountMinor.toString(), scenario, input.expiresAt, awaitsPayer, now],
    );
    if (inserted.rowCount === 0) return { view: this.view((await this.findCharge(input.reference)) as ChargeRow, now), created: false }; // carrera: la ganó otro pedido
    let row = inserted.rows[0] as ChargeRow;
    if (!awaitsPayer) row = await this.applyPayment(row, now);
    // El cobro EXISTE; lo que se pierde es la respuesta (escenario 07): quien reintenta con la misma referencia recibe este mismo cobro.
    if (scenario === 'ambiguous_timeout') throw new BankSocketCut('hang');
    // La creación responde `pending` (salvo un rechazo síncrono): la confirmación llega por callback o por consulta, como en el simulador en proceso.
    const view = this.view(row, now);
    return { view: view.status === 'failed' ? view : { ...view, status: 'pending' }, created: true };
  }

  /**
   * El pagador «paga»: fija `paid_at` según el escenario y programa los callbacks. Es lo que hace el banco al recibir el dinero. Idempotente:
   * si ya se pagó (o no se paga nunca) devuelve la fila como está.
   */
  private async applyPayment(row: ChargeRow, now: Date): Promise<ChargeRow> {
    if (row.paid_at || row.scenario === 'declined' || row.scenario === 'never_paid' || row.canceled) return row;
    const paidAt = row.scenario === 'delayed' ? new Date(now.getTime() + this.config.delayMs) : now;
    const updated = await this.pool.query('UPDATE mb_charges SET paid_at = $2, awaits_payer = false WHERE reference = $1 AND paid_at IS NULL RETURNING *', [row.reference, paidAt]);
    if (updated.rowCount === 0) return (await this.findCharge(row.reference)) as ChargeRow;
    const paid = updated.rows[0] as ChargeRow;
    const amount = BigInt(paid.amount_minor);
    const callbacks: Array<{ ordinal: number; status: BankStatus; due: Date; occurred: Date }> = [];
    switch (paid.scenario) {
      case 'approved':
      case 'statement_mismatch':
      case 'ambiguous_timeout':
        callbacks.push({ ordinal: 0, status: 'captured', due: now, occurred: now });
        break;
      case 'delayed':
        callbacks.push({ ordinal: 0, status: 'captured', due: paidAt, occurred: paidAt });
        break;
      case 'duplicate_callback':
        // El MISMO evento (mismo id) tres veces.
        for (let copy = 0; copy < 3; copy += 1) callbacks.push({ ordinal: 0, status: 'captured', due: now, occurred: now });
        break;
      case 'out_of_order':
        // Primero llega el hecho POSTERIOR (captured) y después el anterior (authorized).
        callbacks.push({ ordinal: 0, status: 'captured', due: now, occurred: new Date(now.getTime() + 1000) });
        callbacks.push({ ordinal: 1, status: 'authorized', due: now, occurred: now });
        break;
      case 'lost_callback':
      default:
        break; // el callback nunca se programa
    }
    for (const cb of callbacks) await this.schedule(this.pool, paid.reference, cb.ordinal, cb.status, cb.occurred, amount, cb.due);
    return paid;
  }

  private async schedule(db: Pool | PoolClient, reference: string, ordinal: number, status: string, occurredAt: Date, amount: bigint, dueAt: Date, failureCode?: string): Promise<void> {
    await db.query(
      `INSERT INTO mb_callbacks (event_id, reference, status, occurred_at, amount_minor, failure_code, due_at, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [eventIdFor(reference, status, ordinal), reference, status, occurredAt, amount.toString(), failureCode ?? null, dueAt],
    );
  }

  private async findCharge(reference: string): Promise<ChargeRow | null> {
    return ((await this.pool.query('SELECT * FROM mb_charges WHERE reference = $1', [reference])).rows[0] as ChargeRow | undefined) ?? null;
  }

  private async requireCharge(reference: string): Promise<ChargeRow> {
    const row = await this.findCharge(reference);
    if (!row) throw new BankProblem(404, 'charge_not_found');
    return row;
  }

  private statusOf(row: ChargeRow, now: Date): BankStatus {
    if (row.scenario === 'declined') return 'failed';
    if (row.canceled) return 'canceled';
    if (row.paid_at && now.getTime() >= row.paid_at.getTime()) return 'captured';
    if (now.getTime() >= row.expires_at.getTime()) return 'expired';
    return 'pending';
  }

  private view(row: ChargeRow, now: Date): ChargeView {
    const status = this.statusOf(row, now);
    const occurredAt = status === 'captured' ? (row.paid_at as Date) : status === 'expired' ? row.expires_at : now;
    return { bankReference: row.bank_reference, status, ...(status === 'failed' ? { failureCode: 'card_declined' } : {}), occurredAt };
  }

  async getCharge(reference: string): Promise<ChargeView> {
    await this.assertUp();
    return this.view(await this.requireCharge(reference), this.clock.now());
  }

  async cancelCharge(reference: string): Promise<BankStatus> {
    await this.assertUp();
    const row = await this.requireCharge(reference);
    const now = this.clock.now();
    const status = this.statusOf(row, now);
    if (status === 'canceled') return 'canceled';
    if (status !== 'pending') throw new BankProblem(409, 'invalid_state');
    await this.pool.query('UPDATE mb_charges SET canceled = true WHERE reference = $1', [reference]);
    return 'canceled';
  }

  /** Registra el QR que la pasarela emitió para el cobro (el pagador simulado lo busca por este texto exacto). Idempotente. */
  async registerQr(reference: string, payload: string): Promise<void> {
    await this.assertUp();
    const row = await this.requireCharge(reference);
    if (row.qr_payload === payload) return;
    if (row.qr_payload !== null) throw new BankProblem(409, 'qr_conflict', 'el cobro ya tiene otro QR');
    try {
      await this.pool.query('UPDATE mb_charges SET qr_payload = $2 WHERE reference = $1', [reference, payload]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new BankProblem(409, 'qr_conflict', 'ese QR ya pertenece a otro cobro');
      throw error;
    }
  }

  /**
   * Pago de un QR por el pagador simulado. Se valida TODO (QR conocido, estado, monto) antes de tocar nada: un pago rechazado no deja efecto.
   * `qrAmountMinor` es el monto que pay-qr leyó del QR.
   */
  async payByQr(payload: string, qrAmountMinor: bigint): Promise<{ row: ChargeRow; view: ChargeView; alreadyPaid: boolean }> {
    await this.assertUp();
    const found = (await this.pool.query('SELECT * FROM mb_charges WHERE qr_payload = $1', [payload])).rows[0] as ChargeRow | undefined;
    if (!found) throw new BankProblem(404, 'qr_not_registered');
    const now = this.clock.now();
    const status = this.statusOf(found, now);
    if (status === 'canceled' || status === 'expired' || status === 'failed') throw new BankProblem(409, 'invalid_state', `el QR está ${status}`);
    if (BigInt(found.amount_minor) !== qrAmountMinor) throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'amount_mismatch' }] });
    const alreadyPaid = found.paid_at !== null;
    const row = alreadyPaid ? found : await this.applyPayment(found, now);
    return { row, view: this.view(row, now), alreadyPaid };
  }

  amountOf(row: ChargeRow): bigint {
    return BigInt(row.amount_minor);
  }

  // ───────────────────────────── reembolsos ─────────────────────────────

  async refund(input: { reference: string; chargeReference: string; amountMinor: bigint }): Promise<{ bankReference: string; status: 'captured' | 'failed'; failureCode?: string }> {
    await this.assertUp();
    // Se serializa por cobro con el candado de su fila: dos reembolsos DISTINTOS a la vez no pueden pasarse del importe cobrado (como un banco real).
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT * FROM mb_charges WHERE reference = $1 FOR UPDATE', [input.chargeReference])).rows[0] as ChargeRow | undefined;
      if (!locked) {
        await client.query('ROLLBACK');
        throw new BankProblem(404, 'charge_not_found');
      }
      const previous = (await client.query('SELECT bank_reference FROM mb_refunds WHERE reference = $1', [input.reference])).rows[0] as { bank_reference: string } | undefined;
      if (previous) {
        await client.query('COMMIT');
        return { bankReference: previous.bank_reference, status: 'captured' };
      }
      const now = this.clock.now();
      if (this.statusOf(locked, now) !== 'captured') {
        await client.query('ROLLBACK');
        throw new BankProblem(409, 'invalid_state');
      }
      const refunded = BigInt((await client.query('SELECT COALESCE(sum(amount_minor), 0)::text AS total FROM mb_refunds WHERE charge_reference = $1', [locked.reference])).rows[0].total as string);
      const bankReference = await this.nextBankReference('SIM-R');
      if (refunded + input.amountMinor > BigInt(locked.amount_minor)) {
        // Rechazo explícito del banco: no se reembolsó nada y no se guarda la referencia.
        await client.query('COMMIT');
        return { bankReference, status: 'failed', failureCode: 'validation_failed' };
      }
      await client.query('INSERT INTO mb_refunds (reference, charge_reference, bank_reference, amount_minor, created_at) VALUES ($1, $2, $3, $4, $5)', [input.reference, locked.reference, bankReference, input.amountMinor.toString(), now]);
      await client.query('COMMIT');
      return { bankReference, status: 'captured' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRefund(reference: string): Promise<{ bankReference: string; status: 'captured' }> {
    await this.assertUp();
    const found = (await this.pool.query('SELECT bank_reference FROM mb_refunds WHERE reference = $1', [reference])).rows[0] as { bank_reference: string } | undefined;
    if (!found) throw new BankProblem(404, 'refund_not_found');
    return { bankReference: found.bank_reference, status: 'captured' };
  }

  // ───────────────────────────── transferencias salientes ─────────────────────────────

  async transfer(input: { reference: string; amountMinor: bigint }): Promise<{ bankReference: string; status: 'paid' | 'in_transit' | 'failed'; failureCode?: string }> {
    await this.assertUp();
    const now = this.clock.now();
    const existing = await this.findTransfer(input.reference);
    if (existing) return this.transferView(existing, now);
    const scenario = scenarioFor(input.amountMinor);
    if (scenario === 'down') throw new BankProblem(503, 'bank_unavailable');
    const bankReference = await this.nextBankReference('SIM-T');
    await this.pool.query(
      'INSERT INTO mb_transfers (reference, bank_reference, amount_minor, scenario, delay_ms, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (reference) DO NOTHING',
      [input.reference, bankReference, input.amountMinor.toString(), scenario, this.config.delayMs, now],
    );
    const created = (await this.findTransfer(input.reference)) as TransferRow;
    // La orden quedó EJECUTADA; lo que se pierde es la respuesta.
    const ambiguity = transferAmbiguity(input.amountMinor);
    if (ambiguity === 'timeout') throw new BankSocketCut('hang');
    if (ambiguity === 'socket_reset') throw new BankSocketCut('reset');
    if (ambiguity === 'proxy_bad_gateway_html') throw new BankProxyHtml();
    return this.transferView(created, now);
  }

  async getTransfer(reference: string): Promise<{ bankReference: string; status: 'paid' | 'in_transit' | 'failed'; failureCode?: string }> {
    await this.assertUp();
    const found = await this.findTransfer(reference);
    if (!found) throw new BankProblem(404, 'transfer_not_found'); // respuesta explícita: no hay registro
    return this.transferView(found, this.clock.now());
  }

  private async findTransfer(reference: string): Promise<TransferRow | null> {
    return ((await this.pool.query('SELECT * FROM mb_transfers WHERE reference = $1', [reference])).rows[0] as TransferRow | undefined) ?? null;
  }

  private transferView(row: TransferRow, now: Date): { bankReference: string; status: 'paid' | 'in_transit' | 'failed'; failureCode?: string } {
    switch (row.scenario) {
      case 'declined':
        return { bankReference: row.bank_reference, status: 'failed', failureCode: 'rejected_by_bank' };
      case 'delayed':
        return { bankReference: row.bank_reference, status: now.getTime() - row.created_at.getTime() >= row.delay_ms ? 'paid' : 'in_transit' };
      case 'never_paid':
        return { bankReference: row.bank_reference, status: 'in_transit' };
      default:
        return { bankReference: row.bank_reference, status: 'paid' };
    }
  }

  // ───────────────────────────── tarjeta: autorización / captura / anulación ─────────────────────────────

  async authorizeCard(input: { reference: string; amountMinor: bigint }): Promise<{ view: CardView; created: boolean }> {
    await this.assertUp();
    const existing = await this.findCard(input.reference);
    if (existing) return { view: cardView(existing), created: false };
    const scenario = scenarioFor(input.amountMinor);
    if (scenario === 'down') throw new BankProblem(503, 'bank_unavailable');
    const declined = scenario === 'declined';
    const bankReference = await this.nextBankReference('SIM-C');
    const inserted = await this.pool.query(
      'INSERT INTO mb_card_auths (reference, bank_reference, amount_minor, status, scenario, failure_code, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (reference) DO NOTHING RETURNING *',
      [input.reference, bankReference, input.amountMinor.toString(), declined ? 'declined' : 'authorized', scenario, declined ? 'card_declined' : null, this.clock.now()],
    );
    // Carrera: otro pedido con la misma referencia ganó la inserción. Este devuelve SU autorización, sin declararse creador.
    if (inserted.rowCount === 0) return { view: cardView((await this.findCard(input.reference)) as CardRow), created: false };
    const row = inserted.rows[0] as CardRow;
    if (scenario === 'ambiguous_timeout') throw new BankSocketCut('hang');
    return { view: cardView(row), created: true };
  }

  async captureCard(reference: string, amountMinor?: bigint): Promise<CardView> {
    await this.assertUp();
    const row = await this.requireCard(reference);
    if (row.status === 'captured') return cardView(row); // idempotente
    if (row.status !== 'authorized') throw new BankProblem(409, 'invalid_state', `la autorización está ${row.status}`);
    const amount = amountMinor ?? BigInt(row.amount_minor);
    if (amount <= 0n || amount > BigInt(row.amount_minor)) throw new BankProblem(409, 'invalid_state', 'monto a capturar fuera de la autorización');
    const now = this.clock.now();
    const updated = await this.pool.query("UPDATE mb_card_auths SET status = 'captured', captured_minor = $2 WHERE reference = $1 AND status = 'authorized' RETURNING *", [reference, amount.toString()]);
    if (updated.rowCount === 0) {
      // Carrera: otra operación cambió el estado entre la lectura y la escritura. Si ya está capturada es la misma operación (idempotente); si no, es un conflicto.
      const current = await this.requireCard(reference);
      if (current.status === 'captured') return cardView(current);
      throw new BankProblem(409, 'invalid_state', `la autorización está ${current.status}`);
    }
    await this.schedule(this.pool, reference, 0, 'captured', now, amount, now);
    return cardView(updated.rows[0] as CardRow);
  }

  async voidCard(reference: string): Promise<CardView> {
    await this.assertUp();
    const row = await this.requireCard(reference);
    if (row.status === 'voided') return cardView(row); // idempotente
    if (row.status !== 'authorized') throw new BankProblem(409, 'invalid_state', `la autorización está ${row.status}`);
    const now = this.clock.now();
    const updated = await this.pool.query("UPDATE mb_card_auths SET status = 'voided' WHERE reference = $1 AND status = 'authorized' RETURNING *", [reference]);
    if (updated.rowCount === 0) {
      const current = await this.requireCard(reference);
      if (current.status === 'voided') return cardView(current);
      throw new BankProblem(409, 'invalid_state', `la autorización está ${current.status}`);
    }
    await this.schedule(this.pool, reference, 0, 'canceled', now, BigInt(row.amount_minor), now);
    return cardView(updated.rows[0] as CardRow);
  }

  async getCard(reference: string): Promise<CardView> {
    await this.assertUp();
    return cardView(await this.requireCard(reference));
  }

  private async findCard(reference: string): Promise<CardRow | null> {
    return ((await this.pool.query('SELECT * FROM mb_card_auths WHERE reference = $1', [reference])).rows[0] as CardRow | undefined) ?? null;
  }

  private async requireCard(reference: string): Promise<CardRow> {
    const row = await this.findCard(reference);
    if (!row) throw new BankProblem(404, 'card_authorization_not_found');
    return row;
  }

  // ───────────────────────────── extracto ─────────────────────────────

  async statement(range: { from: Date; to: Date }, account?: StatementAccount): Promise<StatementEntry[]> {
    await this.assertUp();
    const charges = account === 'transfers' ? [] : (await this.pool.query('SELECT * FROM mb_charges WHERE paid_at IS NOT NULL AND paid_at >= $1 AND paid_at <= $2', [range.from, range.to])).rows as ChargeRow[];
    const entries: StatementEntry[] = charges.map((charge) => {
      const paidAt = charge.paid_at as Date;
      // El escenario `statement_mismatch` informa Bs 1,00 menos que lo cobrado.
      const booked = charge.scenario === 'statement_mismatch' ? BigInt(charge.amount_minor) - 100n : BigInt(charge.amount_minor);
      return { bankReference: `${charge.bank_reference}-L`, ourReference: charge.reference, direction: 'credit', amountMinor: booked, valueDate: paidAt.toISOString().slice(0, 10), bookedAt: paidAt, description: 'ABONO SIMULADO' };
    });
    const extras = (await this.pool.query('SELECT * FROM mb_statement_extra WHERE booked_at >= $1 AND booked_at <= $2 AND ($3::text IS NULL OR account = $3)', [range.from, range.to, account ?? null])).rows as Array<Record<string, unknown>>;
    for (const e of extras) {
      entries.push({ bankReference: e.bank_reference as string, ourReference: (e.our_reference as string | null) ?? null, direction: e.direction as 'credit' | 'debit', amountMinor: BigInt(e.amount_minor as string), valueDate: (e.value_date as Date).toISOString().slice(0, 10), bookedAt: e.booked_at as Date, description: (e.description as string | null) ?? null });
    }
    return entries.sort((a, b) => b.bookedAt.getTime() - a.bookedAt.getTime() || (a.bankReference < b.bankReference ? 1 : -1));
  }

  async injectStatementLine(line: { ourReference: string | null; direction: 'credit' | 'debit'; amountMinor: bigint; bookedAt: Date; description: string | null; account?: StatementAccount }): Promise<string> {
    await this.assertUp();
    const bankReference = await this.nextBankReference('SIM-X');
    await this.pool.query(
      'INSERT INTO mb_statement_extra (bank_reference, our_reference, direction, amount_minor, value_date, booked_at, description, account) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [bankReference, line.ourReference, line.direction, line.amountMinor.toString(), line.bookedAt.toISOString().slice(0, 10), line.bookedAt, line.description, line.account ?? 'collections'],
    );
    return bankReference;
  }

  /**
   * DEPÓSITO del pagador: transfiere al banco escribiendo la referencia de las instrucciones. El banco no avisa a nadie (como un banco real): la
   * línea aparece en el extracto de la cuenta `transfers` y la pasarela la concilia. Cada llamada es un depósito distinto.
   */
  async payerTransferIn(input: { reference: string; amountMinor: bigint }): Promise<{ bankReference: string }> {
    const bankReference = await this.injectStatementLine({ ourReference: input.reference, direction: 'credit', amountMinor: input.amountMinor, bookedAt: this.clock.now(), description: 'TRANSFERENCIA SIMULADA', account: 'transfers' });
    return { bankReference };
  }
}

interface TransferRow {
  reference: string;
  bank_reference: string;
  scenario: Scenario;
  delay_ms: number;
  created_at: Date;
}

interface CardRow {
  reference: string;
  bank_reference: string;
  amount_minor: string;
  captured_minor: string;
  status: 'authorized' | 'captured' | 'voided' | 'declined';
  failure_code: string | null;
}

export interface CardView {
  readonly bankReference: string;
  readonly status: CardRow['status'];
  readonly amountMinor: bigint;
  readonly capturedMinor: bigint;
  readonly failureCode?: string;
}

function cardView(row: CardRow): CardView {
  return { bankReference: row.bank_reference, status: row.status, amountMinor: BigInt(row.amount_minor), capturedMinor: BigInt(row.captured_minor), ...(row.failure_code ? { failureCode: row.failure_code } : {}) };
}
