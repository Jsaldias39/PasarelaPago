import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson } from '@pay/idempotency';
import { toSafeNumber } from '@pay/money';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { AccountRegistry } from './account-registry';
import { type AccountInfo, callerMayTouch, parseAccount } from './accounts';
import { isChargeback, planLegs } from './chargeback';
import { resolveAccounts } from './resolve-accounts';
import { decideAttempt } from './attempts';
import { type BalanceDto, type LegDto, type TransactionDto, balanceOf } from './dto';
import { type PostedLeg, emitTransferPosted } from './ledger-events';
import { accountTbId, publicId, txGroupId } from './ids';
import type { PayMode } from './mode';
import { parseOrThrow, accountQuery, statementQuery, transactionCreate, merchantId } from './schemas';
import { CreateTransferStatus, TB_ENGINE, TigerBeetleEngine, isConflictStatus, plainTransfer, sameTransfer, transferStatusName } from './tb-engine';
import { inTransaction } from './unit-of-work';

interface TransactionRow {
  id: string;
  attempt: number;
  status: 'posted' | 'rejected';
  content_hash: string;
  reject_code: 'insufficient_funds' | 'validation_failed' | null;
  currency: 'BOB';
  legs: LegDto[];
  created_at: Date;
}

type Outcome =
  | { kind: 'ok'; created: boolean; row: TransactionRow }
  | { kind: 'problem'; error: ProblemError };

/** Resultado de interpretar el lote que devolvió TigerBeetle. */
type Verdict = { kind: 'posted'; replay: boolean } | { kind: 'rejected'; code: 'insufficient_funds'; tbStatus: string } | { kind: 'conflict'; tbStatus: string };

/** Traduce los estados de TigerBeetle. Cualquier otro es un fallo inesperado, nunca se disfraza de rechazo de negocio. */
export function interpretTransfers(statuses: readonly number[]): Verdict {
  // El id ya existe con OTRO contenido: la misma clave (business_ref, attempt) se reutilizó con otro cuerpo. Nunca es un éxito.
  const conflict = statuses.find(isConflictStatus);
  if (conflict !== undefined) return { kind: 'conflict', tbStatus: transferStatusName(conflict) };
  if (statuses.every((s) => s === CreateTransferStatus.created)) return { kind: 'posted', replay: false };
  if (statuses.every((s) => s === CreateTransferStatus.exists)) return { kind: 'posted', replay: true };
  const culprit = statuses.find(
    (s) => s === CreateTransferStatus.exceeds_credits || s === CreateTransferStatus.exceeds_debits || s === CreateTransferStatus.id_already_failed,
  );
  // `id_already_failed` solo aparece al reintentar tras caerse entre TigerBeetle y Postgres; la única razón de negocio por la que
  // TigerBeetle rechaza un lote bien formado es el saldo (DECISIONES-TOMADAS.md D5).
  if (culprit !== undefined) return { kind: 'rejected', code: 'insufficient_funds', tbStatus: transferStatusName(culprit) };
  throw new Error(`TigerBeetle devolvió estados inesperados: ${statuses.map(transferStatusName).join(',')}`);
}

/** `422 idempotency_key_reused` (el código que el contrato declara para esta ruta): el mismo `(business_ref, attempt)` con otro cuerpo. */
const reusedKey = () => new ProblemError('idempotency_key_reused', { detail: 'El (business_ref, attempt) ya se aplicó con otro contenido' });

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

@Injectable()
export class LedgerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
    private readonly accounts: AccountRegistry,
  ) {}

  /**
   * `POST /transactions`. Todas las patas o ninguna (lote enlazado de TigerBeetle). Idempotente por (business_ref, attempt) y con la
   * regla de intentos hecha cumplir acá (H-TB1). Un rechazo de negocio queda registrado y se responde 422.
   */
  async createTransaction(rawBody: unknown, caller: string, mode: PayMode): Promise<{ created: boolean; body: TransactionDto }> {
    const input = parseOrThrow(transactionCreate, rawBody);
    const legs: LegDto[] = input.legs.map((leg) => ({ ...leg, code: leg.code ?? 'adjustment' }));
    const infos = resolveAccounts(legs, caller);
    // Un contracargo que supera lo pendiente deja el exceso como deuda del comercio: el llamador tiene que poder tocar esa cuenta.
    if (legs.some(isChargeback) && !callerMayTouch(caller, 'merchant_debt')) throw new ProblemError('forbidden', { detail: 'El servicio llamador no puede tocar ese tipo de cuenta' });
    const contentHash = sha256({ currency: input.currency, legs });

    const outcome = await inTransaction(this.pool, async (client): Promise<Outcome> => {
      // Serializa a quienes operan sobre la misma operación de negocio: la decisión de intento y la escritura son una sola unidad.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ledger:tx:${mode}:${input.business_ref}`]);
      const { rows } = await client.query<TransactionRow>(
        'SELECT id, attempt, status, content_hash, reject_code, currency, legs, created_at FROM ledger_transactions WHERE mode = $1 AND business_ref = $2 ORDER BY attempt',
        [mode, input.business_ref],
      );
      const decision = decideAttempt(rows, input.attempt);
      if (decision.kind === 'conflict') {
        return { kind: 'problem', error: new ProblemError('invalid_state_transition', { detail: decision.reason }) };
      }
      if (decision.kind === 'same') {
        if (decision.row.content_hash !== contentHash) return { kind: 'problem', error: new ProblemError('idempotency_key_reused') };
        return decision.row.status === 'posted'
          ? { kind: 'ok', created: false, row: decision.row }
          : { kind: 'problem', error: new ProblemError(decision.row.reject_code ?? 'validation_failed', { detail: 'Intento rechazado antes; reintentar exige attempt + 1' }) };
      }

      // Dos contracargos del mismo comercio no se parten a la vez sobre el mismo saldo pendiente.
      const plan = await (async () => {
        const merchants = legs.filter(isChargeback).map((leg) => parseAccount(leg.debit_account)?.merchantId as string);
        for (const merchant of [...new Set(merchants)].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ledger:chargeback:${mode}:${merchant}`]);
        return planLegs(this.tb, mode, input.business_ref, input.attempt, legs);
      })();
      const settled = plan.legs; // lo que se asienta de verdad (con el contracargo ya partido)
      const settledInfos = new Map(infos);
      for (const leg of settled) for (const name of [leg.debit_account, leg.credit_account]) if (!settledInfos.has(name)) settledInfos.set(name, parseAccount(name) as AccountInfo);
      await this.accounts.register(client, mode, [...settledInfos.values()]);
      const batch = settled.map((leg, index) =>
        plainTransfer(
          {
            id: plan.tbIds[index],
            debit: accountTbId(mode, leg.debit_account),
            credit: accountTbId(mode, leg.credit_account),
            amount: BigInt(leg.amount_minor),
            code: leg.code,
            meta: { mode, group: txGroupId(mode, input.business_ref, input.attempt) },
          },
          index < settled.length - 1,
        ),
      );
      let statuses = await this.tb.createTransfers(batch);
      // En un lote enlazado, un `exists` hace fallar a toda la cadena (`linked_event_failed` en las demás, SIN mirar su contenido). Para tratarlo
      // como «ya aplicado» (caída antes de registrarlo en Postgres) hace falta que TODAS las patas guardadas en TigerBeetle sean EXACTAMENTE las que se
      // piden ahora; si alguna falta o difiere, la clave se reutilizó con otro cuerpo y no se devuelve éxito.
      if (batch.length > 1 && statuses.some((st) => st === CreateTransferStatus.exists) && statuses.every((st) => st === CreateTransferStatus.exists || st === CreateTransferStatus.linked_event_failed)) {
        const stored = new Map((await this.tb.lookupTransfers(plan.tbIds)).map((t) => [t.id, t]));
        const identical = batch.every((expected) => {
          const found = stored.get(expected.id);
          return found !== undefined && sameTransfer(found, expected);
        });
        if (!identical) return { kind: 'problem', error: reusedKey() };
        statuses = statuses.map(() => CreateTransferStatus.exists);
      }
      const verdict = interpretTransfers(statuses);
      if (verdict.kind === 'conflict') return { kind: 'problem', error: reusedKey() };
      const txId = publicId('tx', mode, input.business_ref, input.attempt);
      const now = new Date();

      if (verdict.kind === 'rejected') {
        await this.insertTransaction(client, { mode, txId, input, contentHash, status: 'rejected', rejectCode: verdict.code, legs });
        await client.query(
          'INSERT INTO ledger_rejections (mode, kind, business_ref, attempt, reject_code, tb_status, caller) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [mode, 'transaction', input.business_ref, input.attempt, verdict.code, verdict.tbStatus, caller],
        );
        return { kind: 'problem', error: new ProblemError(verdict.code, { detail: 'Saldo insuficiente; reintentar exige attempt + 1' }) };
      }

      const row = await this.insertTransaction(client, { mode, txId, input, contentHash, status: 'posted', rejectCode: null, legs: settled });
      await this.recordLegs(client, { mode, source: 'transaction', sourceId: txId, businessRef: input.business_ref, attempt: input.attempt, legs: settled, postedAt: now });
      return { kind: 'ok', created: true, row };
    });

    if (outcome.kind === 'problem') throw outcome.error;
    return { created: outcome.created, body: this.toTransactionDto(outcome.row, outcome.created ? 'created' : 'exists', input.business_ref) };
  }

  private async insertTransaction(
    client: PoolClient,
    p: { mode: PayMode; txId: string; input: { business_ref: string; attempt: number; currency: 'BOB' }; contentHash: string; status: 'posted' | 'rejected'; rejectCode: string | null; legs: LegDto[] },
  ): Promise<TransactionRow> {
    const { rows } = await client.query<TransactionRow>(
      `INSERT INTO ledger_transactions (id, mode, business_ref, attempt, content_hash, status, reject_code, currency, legs)
       VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id, attempt, status, content_hash, reject_code, currency, legs, created_at`,
      [p.txId, p.input.business_ref, p.input.attempt, p.contentHash, p.status, p.rejectCode, p.input.currency, JSON.stringify(p.legs), p.mode],
    );
    return rows[0];
  }

  /** Guarda las patas asentadas, sus líneas de extracto y encola `ledger.transfer.posted` — todo en la transacción del llamador. */
  async recordLegs(
    client: PoolClient,
    p: { mode: PayMode; source: 'transaction' | 'hold'; sourceId: string; businessRef: string; attempt: number; legs: readonly LegDto[]; postedAt: Date },
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, leg] of p.legs.entries()) {
      const legId = publicId('tf', p.sourceId, index);
      ids.push(legId);
      await client.query(
        `INSERT INTO ledger_legs (id, mode, source, source_id, business_ref, attempt, leg_index, debit_account, credit_account, amount_minor, code, posted_at)
         VALUES ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [legId, p.source, p.sourceId, p.businessRef, p.attempt, index, leg.debit_account, leg.credit_account, leg.amount_minor, leg.code, p.postedAt, p.mode],
      );
      for (const side of ['debit', 'credit'] as const) {
        const account = side === 'debit' ? leg.debit_account : leg.credit_account;
        const counterparty = side === 'debit' ? leg.credit_account : leg.debit_account;
        await client.query(
          `INSERT INTO ledger_statement_lines (id, mode, account, leg_id, business_ref, attempt, leg_index, direction, counterparty_account, amount_minor, code, posted_at)
           VALUES ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [publicId('sl', legId, side), account, legId, p.businessRef, p.attempt, index, side, counterparty, leg.amount_minor, leg.code, p.postedAt, p.mode],
        );
      }
      const event: PostedLeg = {
        mode: p.mode,
        transferId: legId,
        businessRef: p.businessRef,
        attempt: p.attempt,
        code: leg.code,
        debitAccount: leg.debit_account,
        creditAccount: leg.credit_account,
        amountMinor: leg.amount_minor,
        postedAt: p.postedAt,
      };
      await emitTransferPosted(client, event);
    }
    return ids;
  }

  private toTransactionDto(row: TransactionRow, result: 'created' | 'exists', businessRef: string): TransactionDto {
    return {
      id: row.id,
      object: 'transaction',
      result,
      business_ref: businessRef,
      attempt: row.attempt,
      status: row.status,
      reject_code: row.reject_code,
      currency: row.currency,
      legs: row.legs,
      created_at: row.created_at.toISOString(),
    };
  }

  /** `GET /transactions/{business_ref}` — todos los intentos, del más nuevo al más viejo, incluidos los rechazados. */
  async getTransaction(businessRef: string, mode: PayMode): Promise<{ business_ref: string; attempts: TransactionDto[] }> {
    const { rows } = await this.pool.query<TransactionRow>(
      'SELECT id, attempt, status, content_hash, reject_code, currency, legs, created_at FROM ledger_transactions WHERE mode = $1 AND business_ref = $2 ORDER BY attempt DESC',
      [mode, businessRef],
    );
    if (rows.length === 0) throw new ProblemError('resource_not_found');
    return { business_ref: businessRef, attempts: rows.map((row) => this.toTransactionDto(row, 'exists', businessRef)) };
  }

  /** `GET /balances?account=` */
  async getBalance(rawQuery: unknown, mode: PayMode): Promise<BalanceDto> {
    const { account } = parseOrThrow(accountQuery, rawQuery);
    const info = parseAccount(account) as AccountInfo;
    const known = await this.pool.query('SELECT 1 FROM ledger_accounts WHERE mode = $1 AND account = $2', [mode, account]);
    if (known.rowCount === 0) throw new ProblemError('resource_not_found');
    const [tbAccount] = await this.tb.lookupAccounts([accountTbId(mode, account)]);
    return balanceOf(info, tbAccount, new Date());
  }

  /** `GET /balance` público: saldo del comercio autenticado. Una cuenta que nunca se movió vale 0. */
  async getMerchantBalance(rawMerchantId: unknown, mode: PayMode): Promise<{ object: 'balance'; currency: 'BOB'; pending_minor: number; available_minor: number; as_of: string }> {
    const id = merchantId.safeParse(rawMerchantId);
    if (!id.success) throw new ProblemError('unauthorized');
    const pendingId = accountTbId(mode, `merchant:${id.data}:pending`);
    const availableId = accountTbId(mode, `merchant:${id.data}:available`);
    const net = (a: { credits_posted: bigint; debits_posted: bigint; debits_pending: bigint } | undefined) =>
      a ? toSafeNumber(a.credits_posted - a.debits_posted - a.debits_pending) : 0;
    // `lookupAccounts` omite las cuentas inexistentes: hay que asociar por id, no por posición.
    const byId = new Map((await this.tb.lookupAccounts([pendingId, availableId])).map((a) => [a.id, a]));
    return {
      object: 'balance',
      currency: 'BOB',
      pending_minor: net(byId.get(pendingId)),
      available_minor: net(byId.get(availableId)),
      as_of: new Date().toISOString(),
    };
  }

  /** `GET /statements` — orden estable (posted_at desc, id desc) para que la paginación no cambie entre páginas. */
  async listStatement(rawQuery: unknown, mode: PayMode) {
    const q = parseOrThrow(statementQuery, rawQuery);
    const known = await this.pool.query('SELECT 1 FROM ledger_accounts WHERE mode = $1 AND account = $2', [mode, q.account]);
    if (known.rowCount === 0) throw new ProblemError('resource_not_found');
    const cursor = q.starting_after ? decodeCursor(q.starting_after) : null;
    const { rows } = await this.pool.query(
      `SELECT id, business_ref, attempt, leg_index, direction, counterparty_account, amount_minor, code, posted_at
         FROM ledger_statement_lines
        WHERE mode = $7 AND account = $1
          AND ($2::timestamptz IS NULL OR posted_at >= $2)
          AND ($3::timestamptz IS NULL OR posted_at < $3)
          AND ($4::timestamptz IS NULL OR (posted_at, id) < ($4, $5))
        ORDER BY posted_at DESC, id DESC
        LIMIT $6`,
      [q.account, q.from ?? null, q.to ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, mode],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      object: 'list' as const,
      has_more: rows.length > q.limit,
      next_cursor: rows.length > q.limit && last ? encodeCursor(last.posted_at as Date, last.id as string) : null,
      data: page.map((r) => ({
        id: r.id as string,
        business_ref: r.business_ref as string,
        attempt: r.attempt as number,
        leg_index: r.leg_index as number,
        direction: r.direction as 'debit' | 'credit',
        counterparty_account: r.counterparty_account as string,
        amount_minor: Number(r.amount_minor),
        code: r.code as string,
        posted_at: (r.posted_at as Date).toISOString(),
      })),
    };
  }
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
}

function decodeCursor(value: string): { at: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof parsed.at === 'string' && typeof parsed.id === 'string' && !Number.isNaN(Date.parse(parsed.at))) return { at: parsed.at, id: parsed.id };
  } catch {
    /* cae al error de abajo */
  }
  throw new ProblemError('validation_failed', { errors: [{ field: 'starting_after', code: 'invalid_cursor' }] });
}
