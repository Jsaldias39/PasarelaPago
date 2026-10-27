import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdempotencyStore, canonicalJson, hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { AccountRegistry } from './account-registry';
import { type AccountInfo, parseAccount } from './accounts';
import { decideAttempt } from './attempts';
import type { HoldDto, LegDto } from './dto';
import { accountTbId, holdResolveTbId, holdTbId, publicId } from './ids';
import { emitHoldCreated, emitHoldExpired, emitHoldPosted, emitHoldVoided } from './ledger-events';
import type { PayMode } from './mode';
import { LedgerService, interpretTransfers } from './ledger.service';
import { resolveAccounts } from './resolve-accounts';
import { holdCreate, holdId, holdPostBody, parseOrThrow } from './schemas';
import { CreateTransferStatus, type LegCode, TB_ENGINE, TigerBeetleEngine, pendingTransfer, postPendingTransfer, transferStatusName, voidPendingTransfer } from './tb-engine';
import { inTransaction } from './unit-of-work';

interface HoldRow {
  id: string;
  mode: PayMode;
  business_ref: string;
  attempt: number;
  status: 'pending' | 'posted' | 'voided' | 'expired' | 'rejected';
  content_hash: string;
  reject_code: 'insufficient_funds' | 'validation_failed' | null;
  debit_account: string;
  credit_account: string;
  amount_minor: string;
  posted_amount_minor: string | null;
  currency: 'BOB';
  expires_at: Date;
  created_at: Date;
  resolved_at: Date | null;
}

const COLUMNS =
  'id, mode, business_ref, attempt, status, content_hash, reject_code, debit_account, credit_account, amount_minor, posted_amount_minor, currency, expires_at, created_at, resolved_at';

/** `HoldCreate` no trae `code`: se deduce del destino. Propuesta de contrato en PROPUESTAS.md #3. */
export function holdLegCode(debit: AccountInfo, credit: AccountInfo): LegCode {
  if (credit.kind === 'payout_clearing') return 'payout';
  if (debit.kind === 'schedule_reserve' || credit.kind === 'schedule_reserve') return 'mandate';
  return 'adjustment';
}

type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'problem'; error: ProblemError };

@Injectable()
export class HoldService {
  private readonly logger = new Logger(HoldService.name);
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
    private readonly accounts: AccountRegistry,
    private readonly ledger: LedgerService,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  private toDto(row: HoldRow, result: 'created' | 'exists', now = new Date()): HoldDto {
    // Una retención sin resolver cuyo plazo pasó se informa vencida aunque el barrido todavía no la haya marcado.
    const status = row.status === 'pending' && row.expires_at.getTime() <= now.getTime() ? 'expired' : (row.status as HoldDto['status']);
    return {
      id: row.id,
      object: 'hold',
      result,
      business_ref: row.business_ref,
      attempt: row.attempt,
      status,
      debit_account: row.debit_account,
      credit_account: row.credit_account,
      amount_minor: Number(row.amount_minor),
      posted_amount_minor: row.posted_amount_minor === null ? null : Number(row.posted_amount_minor),
      currency: row.currency,
      expires_at: row.expires_at.toISOString(),
      created_at: row.created_at.toISOString(),
      resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    };
  }

  /** `POST /holds` — primera fase. Misma regla de intentos que los asientos (H-TB1). */
  async createHold(rawBody: unknown, caller: string, mode: PayMode): Promise<{ created: boolean; body: HoldDto }> {
    const input = parseOrThrow(holdCreate, rawBody);
    const infos = resolveAccounts([input], caller);
    const debit = infos.get(input.debit_account) as AccountInfo;
    const credit = infos.get(input.credit_account) as AccountInfo;
    const contentHash = createHash('sha256')
      .update(canonicalJson({ d: input.debit_account, c: input.credit_account, a: input.amount_minor, cur: input.currency, e: input.expires_in_seconds }))
      .digest('hex');

    const outcome = await inTransaction(this.pool, async (client): Promise<Outcome<{ created: boolean; row: HoldRow }>> => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ledger:hold:${mode}:${input.business_ref}`]);
      const { rows } = await client.query<HoldRow>(`SELECT ${COLUMNS} FROM ledger_holds WHERE mode = $1 AND business_ref = $2 ORDER BY attempt`, [mode, input.business_ref]);
      const decision = decideAttempt(rows, input.attempt);
      if (decision.kind === 'conflict') return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: decision.reason }) };
      if (decision.kind === 'same') {
        if (decision.row.content_hash !== contentHash) return { kind: 'problem', error: new ProblemError('idempotency_key_reused') };
        return decision.row.status === 'rejected'
          ? { kind: 'problem', error: new ProblemError(decision.row.reject_code ?? 'validation_failed', { detail: 'Intento rechazado antes; reintentar exige attempt + 1' }) }
          : { kind: 'ok', value: { created: false, row: decision.row } };
      }

      await this.accounts.register(client, mode, [debit, credit]);
      const tbId = holdTbId(mode, input.business_ref, input.attempt);
      const statuses = await this.tb.createTransfers([
        pendingTransfer(
          { id: tbId, debit: accountTbId(mode, debit.name), credit: accountTbId(mode, credit.name), amount: BigInt(input.amount_minor), code: holdLegCode(debit, credit) },
          input.expires_in_seconds,
        ),
      ]);
      const verdict = interpretTransfers(statuses);
      if (verdict.kind === 'conflict') return { kind: 'problem', error: new ProblemError('idempotency_key_reused', { detail: 'El (business_ref, attempt) ya se aplicó con otro contenido' }) };
      const hdId = publicId('hd', mode, input.business_ref, input.attempt);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.expires_in_seconds * 1000);
      const base = [hdId, input.business_ref, input.attempt, contentHash, input.debit_account, input.credit_account, input.amount_minor, input.currency, expiresAt, now, mode];

      if (verdict.kind === 'rejected') {
        await client.query(
          `INSERT INTO ledger_holds (id, business_ref, attempt, content_hash, status, reject_code, debit_account, credit_account, amount_minor, currency, expires_at, created_at, mode)
           VALUES ($1, $2, $3, $4, 'rejected', $12, $5, $6, $7, $8, $9, $10, $11)`,
          [...base, verdict.code],
        );
        await client.query('INSERT INTO ledger_rejections (mode, kind, business_ref, attempt, reject_code, tb_status, caller) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          mode,
          'hold',
          input.business_ref,
          input.attempt,
          verdict.code,
          verdict.tbStatus,
          caller,
        ]);
        return { kind: 'problem', error: new ProblemError(verdict.code, { detail: 'Saldo insuficiente; reintentar exige attempt + 1' }) };
      }

      const inserted = await client.query<HoldRow>(
        `INSERT INTO ledger_holds (id, business_ref, attempt, content_hash, status, debit_account, credit_account, amount_minor, currency, expires_at, created_at, mode)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
        base,
      );
      await emitHoldCreated(client, { holdId: hdId, businessRef: input.business_ref, account: input.debit_account, creditAccount: input.credit_account }, {
        attempt: input.attempt,
        amountMinor: input.amount_minor,
        expiresAt,
        at: now,
      });
      return { kind: 'ok', value: { created: true, row: inserted.rows[0] } };
    });

    if (outcome.kind === 'problem') throw outcome.error;
    return { created: outcome.value.created, body: this.toDto(outcome.value.row, outcome.value.created ? 'created' : 'exists') };
  }

  async getHold(rawId: string, mode: PayMode): Promise<HoldDto> {
    const id = holdId.safeParse(rawId);
    // Un id que no tiene la forma de ninguna retención no puede existir: 404 (el contrato declara 404 en las tres rutas; el 400 genérico no tiene código en el catálogo, PROPUESTAS.md #4).
    if (!id.success) throw new ProblemError('resource_not_found');
    const { rows } = await this.pool.query<HoldRow>(`SELECT ${COLUMNS} FROM ledger_holds WHERE mode = $1 AND id = $2 AND status <> 'rejected'`, [mode, id.data]);
    if (rows.length === 0) throw new ProblemError('resource_not_found');
    return this.toDto(rows[0], 'exists');
  }

  /** `POST /holds/{id}/post` — segunda fase. Idempotente por `Idempotency-Key` (se repite la respuesta guardada). */
  postHold(rawId: string, rawBody: unknown, caller: string, mode: PayMode, idempotencyKey: string) {
    const body = parseOrThrow(holdPostBody, rawBody) ?? {};
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/holds/${rawId}/post`, body }) }, async () => ({
      status: 200,
      body: await this.resolve(rawId, mode, 'post', body.amount_minor),
    }));
  }

  /** `POST /holds/{id}/void` — segunda fase. */
  voidHold(rawId: string, caller: string, mode: PayMode, idempotencyKey: string) {
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/holds/${rawId}/void` }) }, async () => ({
      status: 200,
      body: await this.resolve(rawId, mode, 'void'),
    }));
  }

  private async resolve(rawId: string, mode: PayMode, action: 'post' | 'void', requestedAmount?: number): Promise<HoldDto> {
    const id = holdId.safeParse(rawId);
    // Un id que no tiene la forma de ninguna retención no puede existir: 404 (el contrato declara 404 en las tres rutas; el 400 genérico no tiene código en el catálogo, PROPUESTAS.md #4).
    if (!id.success) throw new ProblemError('resource_not_found');

    const outcome = await inTransaction(this.pool, async (client): Promise<Outcome<HoldRow>> => {
      const found = await client.query<HoldRow>(`SELECT ${COLUMNS} FROM ledger_holds WHERE mode = $1 AND id = $2 FOR UPDATE`, [mode, id.data]);
      const row = found.rows[0];
      if (!row || row.status === 'rejected') return { kind: 'problem', error: new ProblemError('resource_not_found') };
      if (row.status !== 'pending') return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: `La retención ya está ${row.status}` }) };

      const now = new Date();
      if (row.expires_at.getTime() <= now.getTime()) {
        await this.markExpired(client, row, now);
        return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: 'La retención venció' }) };
      }
      const held = Number(row.amount_minor);
      const amount = requestedAmount ?? held;
      if (action === 'post' && amount > held) {
        return { kind: 'problem', error: new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'exceeds_hold' }] }) };
      }

      const debit = parseAccount(row.debit_account) as AccountInfo;
      const credit = parseAccount(row.credit_account) as AccountInfo;
      const leg = { id: 0n, debit: accountTbId(mode, row.debit_account), credit: accountTbId(mode, row.credit_account), amount: BigInt(amount), code: holdLegCode(debit, credit) };
      const pendingId = holdTbId(mode, row.business_ref, row.attempt);
      const resolveId = holdResolveTbId(pendingId);
      const [status] = await this.tb.createTransfers([
        action === 'post' ? postPendingTransfer(resolveId, pendingId, { ...leg, id: resolveId }) : voidPendingTransfer(resolveId, pendingId, { ...leg, id: resolveId }),
      ]);

      if (status === CreateTransferStatus.pending_transfer_expired) {
        await this.markExpired(client, row, now);
        return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: 'La retención venció' }) };
      }
      if (status === CreateTransferStatus.pending_transfer_already_posted || status === CreateTransferStatus.pending_transfer_already_voided) {
        // Postgres decía `pending` y TigerBeetle ya la resolvió: se cayó entre los dos. No se adivina el monto; se avisa.
        this.logger.error({ hold: row.id, tb: transferStatusName(status) }, 'La retención ya estaba resuelta en TigerBeetle pero figuraba pendiente en Postgres');
        return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: 'La retención ya fue resuelta' }) };
      }
      if (status === CreateTransferStatus.exceeds_pending_transfer_amount) {
        return { kind: 'problem', error: new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'exceeds_hold' }] }) };
      }
      // `created` (primera vez) y `exists` (reintento tras caerse antes de registrar) terminan igual.
      if (status !== CreateTransferStatus.created && status !== CreateTransferStatus.exists) {
        throw new Error(`TigerBeetle devolvió un estado inesperado al ${action === 'post' ? 'confirmar' : 'anular'} la retención: ${transferStatusName(status)}`);
      }

      const base = { holdId: row.id, businessRef: row.business_ref, account: row.debit_account, creditAccount: row.credit_account };
      if (action === 'post') {
        const updated = await client.query<HoldRow>(
          `UPDATE ledger_holds SET status = 'posted', posted_amount_minor = $2, resolved_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
          [row.id, amount, now],
        );
        const legs: LegDto[] = [{ debit_account: row.debit_account, credit_account: row.credit_account, amount_minor: amount, code: leg.code }];
        const [transferId] = await this.ledger.recordLegs(client, { mode, source: 'hold', sourceId: row.id, businessRef: row.business_ref, attempt: row.attempt, legs, postedAt: now });
        await emitHoldPosted(client, base, { postedAmountMinor: amount, transferId, at: now });
        return { kind: 'ok', value: updated.rows[0] };
      }
      const updated = await client.query<HoldRow>(
        `UPDATE ledger_holds SET status = 'voided', void_reason = 'requested', resolved_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [row.id, now],
      );
      await emitHoldVoided(client, base, { amountMinor: held, reason: 'requested', at: now });
      return { kind: 'ok', value: updated.rows[0] };
    });

    if (outcome.kind === 'problem') throw outcome.error;
    return this.toDto(outcome.value, 'exists');
  }

  private async markExpired(client: PoolClient, row: HoldRow, now: Date): Promise<void> {
    await client.query(`UPDATE ledger_holds SET status = 'expired', resolved_at = $2 WHERE id = $1 AND status = 'pending'`, [row.id, now]);
    await emitHoldExpired(client, { holdId: row.id, businessRef: row.business_ref, account: row.debit_account, creditAccount: row.credit_account }, { amountMinor: Number(row.amount_minor), at: now });
  }

  /**
   * Barrido de retenciones vencidas. TigerBeetle devuelve el monto solo; acá se deja constancia en Postgres y se publica
   * `ledger.hold.expired`. Para no fiarse del reloj de Postgres contra el de TigerBeetle, antes de marcarla se intenta anularla: la
   * respuesta `pending_transfer_expired` confirma que ya venció allá.
   *
   * @returns Cuántas retenciones marcó como vencidas.
   */
  async sweepExpired(skewMs: number, now = new Date()): Promise<number> {
    return inTransaction(this.pool, async (client) => {
      const due = await client.query<HoldRow>(
        `SELECT ${COLUMNS} FROM ledger_holds WHERE status = 'pending' AND expires_at < $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        [new Date(now.getTime() - skewMs)],
      );
      let marked = 0;
      for (const row of due.rows) {
        const pendingId = holdTbId(row.mode, row.business_ref, row.attempt);
        const resolveId = holdResolveTbId(pendingId);
        const debit = parseAccount(row.debit_account) as AccountInfo;
        const credit = parseAccount(row.credit_account) as AccountInfo;
        const [status] = await this.tb.createTransfers([
          voidPendingTransfer(resolveId, pendingId, { id: resolveId, debit: accountTbId(row.mode, row.debit_account), credit: accountTbId(row.mode, row.credit_account), amount: 0n, code: holdLegCode(debit, credit) }),
        ]);
        if (status === CreateTransferStatus.pending_transfer_expired || status === CreateTransferStatus.created) {
          // `created`: TigerBeetle todavía no la había vencido y la anulamos nosotros; el monto vuelve igual. Se informa como vencida.
          await this.markExpired(client, row, now);
          marked += 1;
        } else {
          this.logger.warn({ hold: row.id, tb: transferStatusName(status) }, 'Retención vencida en Postgres con un estado inesperado en TigerBeetle; no se toca');
        }
      }
      return marked;
    });
  }
}
