import { Inject, Injectable } from '@nestjs/common';
import { hashRequest, IdempotencyStore, type HandlerResult, type IdempotencyResult } from '@pay/idempotency';
import type { Queryable } from '@pay/outbox';
import { ProblemError, type FieldError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError, type ConnectorCode, type TransferStatus } from '../domain/connector';
import type { ConnectorRegistry } from '../domain/registry';
import { newId } from '../ids';
import { badRequest } from '../raw-problem';
import { inTransaction } from './db';
import { ProviderGateway } from './provider-gateway';
import { CLOCK, REGISTRY, type Clock } from './tokens';

const BUSINESS_REF = /^[A-Za-z0-9:._-]{3,150}$/;
const REFERENCE = /^[A-Za-z0-9:._-]{3,200}$/;
const CONNECTORS = new Set<string>(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']);
const ALLOWED = new Set(['business_ref', 'attempt', 'connector', 'amount_minor', 'currency', 'destination_ref']);
const fieldName = (key: string): string => (/^[a-z][a-z0-9_]{0,39}$/.test(key) ? key : '?');
const TERMINAL: ReadonlySet<TransferStatus> = new Set(['paid', 'failed']);

interface TransferRow {
  id: string;
  business_ref: string;
  attempt: number;
  caller: string;
  connector: ConnectorCode;
  mode: 'sandbox' | 'live';
  amount_minor: bigint;
  currency: 'BOB';
  destination_ref: string;
  status: TransferStatus;
  provider_reference: string | null;
  failure_code: string | null;
  may_have_reached_provider: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Referencia que se le presenta al proveedor: DETERMINISTA, derivada de (business_ref, attempt). Si el proceso muere entre enviar y
 * registrar la respuesta, el reintento presenta la MISMA referencia y el proveedor deduplica en vez de pagar de nuevo.
 */
const providerReferenceOf = (row: Pick<TransferRow, 'business_ref' | 'attempt'>): string => `${row.business_ref}:${row.attempt}`;

interface CreateTransfer {
  readonly businessRef: string;
  readonly attempt: number;
  readonly connector: ConnectorCode;
  readonly amountMinor: bigint;
  readonly destinationRef: string;
}

const toRow = (raw: Record<string, unknown>): TransferRow => ({ ...(raw as unknown as TransferRow), amount_minor: BigInt(raw.amount_minor as string | number | bigint) });

/** Vista de `Transfer` del contrato. */
function view(row: TransferRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'transfer',
    reference: `${row.business_ref}:${row.attempt}`,
    connector: row.connector,
    mode: row.mode,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function parse(body: unknown): CreateTransfer {
  const errors: FieldError[] = [];
  const bad = (field: string, code: string) => errors.push({ field, code });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError('validation_failed', { errors: [{ field: '/', code: 'not_an_object' }] });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!ALLOWED.has(key)) bad(fieldName(key), 'unknown_field');
  if (typeof b.business_ref !== 'string' || !BUSINESS_REF.test(b.business_ref)) bad('business_ref', 'invalid');
  if (typeof b.attempt !== 'number' || !Number.isSafeInteger(b.attempt) || b.attempt < 1) bad('attempt', 'invalid');
  if (typeof b.connector !== 'string' || !CONNECTORS.has(b.connector)) bad('connector', 'invalid');
  if (typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor < 1) bad('amount_minor', 'invalid');
  if (b.currency !== 'BOB') bad('currency', 'unsupported');
  if (typeof b.destination_ref !== 'string' || b.destination_ref.length < 1 || b.destination_ref.length > 100) bad('destination_ref', 'invalid');
  if (errors.length > 0) throw new ProblemError('validation_failed', { errors });
  return {
    businessRef: b.business_ref as string,
    attempt: b.attempt as number,
    connector: b.connector as ConnectorCode,
    amountMinor: BigInt(b.amount_minor as number),
    destinationRef: b.destination_ref as string,
  };
}

/**
 * Transferencias SALIENTES (pagos a comercios; las pide `pay-settlement`).
 *
 * - Idempotente por `(business_ref, attempt)`: el mismo par con el mismo contenido devuelve la MISMA transferencia (200); con otro
 *   contenido, 422 `idempotency_key_reused`. Una operación de negocio se paga UNA vez (índice único parcial sobre `paid`).
 * - El registro se escribe ANTES de llamar al proveedor. Un fallo ambiguo (timeout) deja la fila `pending`, responde 500 (nunca el
 *   código `connector_unavailable`, que el contrato reserva para «no se envió nada») y se resuelve con `GET /transfers/{reference}`.
 * - Es un registro de dinero de SOLO-AGREGAR: nunca se borra una fila. Solo se cambia de estado, y `failed` únicamente si el proveedor
 *   lo confirmó o el conector garantiza que no envió nada.
 * - 502 `connector_unavailable` (definitivo: «no se envió nada») SOLO si es la PRIMERA llamada que pudo llegar al proveedor
 *   (`may_have_reached_provider = false` antes de llamar) y falló con `ConnectorUnavailableError`. Si hubo cualquier intento previo que
 *   pudo llegar (timeout, corte, 5xx de proxy), un `Unavailable` posterior NO prueba nada: 500 `internal_error`, la fila se conserva.
 * - `404 transfer_not_found` SOLO si el proveedor respondió explícitamente `not_found`.
 */
@Injectable()
export class TransfersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    private readonly idempotency: IdempotencyStore,
    private readonly gateway: ProviderGateway,
  ) {}

  private async findByRef(businessRef: string, attempt: number): Promise<TransferRow | null> {
    const found = await this.pool.query('SELECT * FROM connector_transfers WHERE business_ref = $1 AND attempt = $2', [businessRef, attempt]);
    return found.rows[0] ? toRow(found.rows[0]) : null;
  }

  private async record(client: Queryable, caller: string, input: CreateTransfer): Promise<{ row: TransferRow; existed: boolean }> {
    // Serializa los pedidos de una misma operación de negocio: dos intentos simultáneos no pueden coexistir.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transfer:${input.businessRef}`]);
    const all = (await client.query('SELECT * FROM connector_transfers WHERE business_ref = $1 ORDER BY attempt', [input.businessRef])).rows.map(toRow);
    const same = all.find((r) => r.attempt === input.attempt);
    if (same) {
      if (same.connector !== input.connector || same.amount_minor !== input.amountMinor || same.destination_ref !== input.destinationRef) {
        throw new ProblemError('idempotency_key_reused', { detail: 'Ese business_ref y attempt ya se usaron con otro contenido' });
      }
      return { row: same, existed: true };
    }
    if (all.some((r) => r.status === 'paid')) throw new ProblemError('invalid_state_transition', { detail: 'Esa operación ya tiene una transferencia pagada' });
    const last = all[all.length - 1];
    const expected = last ? last.attempt + 1 : 1;
    if (last && last.status !== 'failed') throw new ProblemError('invalid_state_transition', { detail: 'Hay una transferencia en curso para esa operación' });
    if (input.attempt !== expected) throw new ProblemError('invalid_state_transition', { detail: `El siguiente attempt es ${expected}` });

    const connector = this.registry.get(input.connector);
    if (!connector) throw new ProblemError('validation_failed', { errors: [{ field: 'connector', code: 'not_available' }] });
    if (!connector.createTransfer || !connector.getTransfer) throw new ProblemError('validation_failed', { errors: [{ field: 'connector', code: 'transfers_not_supported' }] });

    const inserted = await client.query(
      `INSERT INTO connector_transfers (id, business_ref, attempt, caller, connector, mode, amount_minor, currency, destination_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'BOB', $8, $9, $9) RETURNING *`,
      [newId('tr'), input.businessRef, input.attempt, caller, input.connector, connector.mode, input.amountMinor.toString(), input.destinationRef, this.clock.now()],
    );
    return { row: toRow(inserted.rows[0]), existed: false };
  }

  async create(caller: string, key: string, body: unknown): Promise<IdempotencyResult> {
    const input = parse(body);
    return this.idempotency.execute({ scope: caller, key, requestHash: hashRequest({ method: 'POST', path: '/transfers', body }) }, async (ctx): Promise<HandlerResult> => {
      let row = ctx.recoveryPoint === 'started' ? null : await this.findByRef(input.businessRef, input.attempt);
      let created = false;
      if (!row) {
        const recorded = await ctx.atomic('transfer_recorded', (client) => this.record(client, caller, input));
        row = recorded.row;
        created = !recorded.existed;
      }
      if (!TERMINAL.has(row.status) && row.provider_reference === null) row = await this.send(ctx, row);
      return { status: created ? 201 : 200, body: view(row) };
    });
  }

  private async send(ctx: Parameters<Parameters<IdempotencyStore['execute']>[1]>[0], row: TransferRow): Promise<TransferRow> {
    // Marca «pudo haber llegado» ANTES de llamar. `prior` dice si ya la había (un intento anterior pudo llegar).
    const prior = row.may_have_reached_provider;
    if (!prior) await this.pool.query('UPDATE connector_transfers SET may_have_reached_provider = true, updated_at = $2 WHERE id = $1', [row.id, this.clock.now()]);
    const reference = providerReferenceOf(row);
    try {
      const result = await this.gateway.callIdempotent(row.connector, row.id, 'create_transfer', (c) =>
        (c.createTransfer as NonNullable<typeof c.createTransfer>).call(c, { reference, amountMinor: row.amount_minor, destinationRef: row.destination_ref }, this.clock.now()),
      );
      return await ctx.atomic('transfer_sent', (client) => this.settle(client, row.id, result.status, result.providerReference, result.failureCode ?? null));
    } catch (error) {
      if (error instanceof ConnectorUnavailableError && !prior) {
        // Primera llamada que pudo llegar y el conector garantiza que NO envió nada: es lo único definitivo. Se cambia de estado (no se
        // borra): `failed` con motivo; el llamador ordena el siguiente attempt.
        await this.pool.query("UPDATE connector_transfers SET status = 'failed', failure_code = 'connector_unavailable', may_have_reached_provider = false, updated_at = $2 WHERE id = $1 AND status = 'pending' AND provider_reference IS NULL", [row.id, this.clock.now()]);
        throw new ProblemError('connector_unavailable', { detail: 'El proveedor no está disponible; no se envió ninguna orden' });
      }
      if (error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError) {
        // AMBIGUO: la orden pudo ejecutarse. Nada de `connector_unavailable`; la fila queda y se resuelve con GET /transfers/{reference}.
        throw new ProblemError('internal_error', { detail: 'Resultado ambiguo: consultá GET /transfers/{reference} antes de decidir' });
      }
      if (error instanceof ConnectorRejectedError && !prior) {
        // Rechazo explícito del proveedor en la primera llamada: confirma que no se pagó.
        return await ctx.atomic('transfer_sent', (client) => this.settle(client, row.id, 'failed', null, error.code));
      }
      if (error instanceof ConnectorRejectedError) {
        throw new ProblemError('internal_error', { detail: 'Resultado ambiguo: consultá GET /transfers/{reference} antes de decidir' });
      }
      throw error;
    }
  }

  private async settle(client: Queryable, id: string, status: TransferStatus, providerReference: string | null, failureCode: string | null): Promise<TransferRow> {
    const updated = await client.query(
      `UPDATE connector_transfers
          SET status = $2, provider_reference = COALESCE($3, provider_reference),
              failure_code = CASE WHEN $2 = 'failed' THEN COALESCE($4, 'rejected_by_provider') ELSE $4 END, updated_at = $5
        WHERE id = $1 AND status NOT IN ('paid', 'failed')
        RETURNING *`,
      [id, status, providerReference, failureCode, this.clock.now()],
    );
    if (updated.rows[0]) return toRow(updated.rows[0]);
    return toRow((await client.query('SELECT * FROM connector_transfers WHERE id = $1', [id])).rows[0]); // ya era terminal: no se retrocede
  }

  async get(reference: string): Promise<Record<string, unknown>> {
    if (!REFERENCE.test(reference)) throw badRequest('Referencia mal formada');
    const cut = reference.lastIndexOf(':');
    const attempt = cut > 0 ? Number(reference.slice(cut + 1)) : NaN;
    if (!Number.isInteger(attempt) || attempt < 1) throw badRequest('La referencia es `business_ref:attempt`');
    const businessRef = reference.slice(0, cut);
    if (!BUSINESS_REF.test(businessRef)) throw badRequest('Referencia mal formada');

    let row = await this.findByRef(businessRef, attempt);
    // Todo registro se escribe ANTES de llamar al proveedor: sin fila, el proveedor nunca recibió esa orden.
    if (!row) throw new ProblemError('transfer_not_found');
    if (TERMINAL.has(row.status)) return view(row);
    const current = row;

    try {
      const observed = await this.gateway.call(row.connector, row.id, 'get_transfer', (c) =>
        (c.getTransfer as NonNullable<typeof c.getTransfer>).call(c, providerReferenceOf(current), this.clock.now()),
      );
      if (observed.status === 'not_found') {
        // El proveedor respondió de forma EXPLÍCITA que no tiene registro: es la única prueba de inexistencia que pide el contrato.
        // La fila NO se borra (solo-agregar); queda pendiente y el mismo par puede volver a enviarse con la misma referencia.
        throw new ProblemError('transfer_not_found');
      }
      if (observed.status !== row.status || row.provider_reference === null) {
        row = await inTransaction(this.pool, (client) => this.settle(client, current.id, observed.status, observed.providerReference, observed.failureCode ?? null));
      }
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      // Sin respuesta, o respuesta que no es un `not_found` explícito (rechazo genérico, 5xx, corte): NO prueba inexistencia.
      // Se devuelve lo último que se sabe (no terminal), que obliga a quien llama a seguir esperando.
      if (!(error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError || error instanceof ConnectorRejectedError)) throw error;
    }
    return view(row);
  }
}
