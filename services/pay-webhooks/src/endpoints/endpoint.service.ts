import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdempotencyStore, hashRequest } from '@pay/idempotency';
import { ProblemError, type FieldError } from '@pay/problem';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { SecretBox } from '../crypto/secret-box';
import { PG_POOL } from '../database.module';
import { DELIVERY_ENGINE, type DeliveryEngine } from '../engine/delivery-engine';
import { PUBLIC_EVENT_TYPES } from '../events/public-events';
import { TargetGuard, TargetRejectedError } from '../ssrf/target-guard';
import { countActiveEndpoints, findOwnedEndpoint, insertEndpoint, listEndpoints, softDeleteEndpoint } from './endpoint.repository';
import { toView, type EndpointRecord, type EndpointView, type SignatureScheme } from './endpoint.types';

export const TARGET_GUARD = Symbol('TARGET_GUARD');
export const SECRET_BOX = Symbol('SECRET_BOX');
export const IDEMPOTENCY = Symbol('IDEMPOTENCY');

const EVENT_PATTERN = /^([a-z_]+\.[a-z_.]+|\*)$/;
const CREATE_FIELDS = ['url', 'enabled_events', 'signature_scheme', 'description'];

export interface EndpointWithSecret extends EndpointView {
  readonly secret: string;
}

interface Replayable<T> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
}

/**
 * ¿El servidor de base de datos RESPONDIÓ con un error de sentencia? Entonces la transacción quedó abortada y no hay duda sobre el COMMIT.
 * (RE-REVISION-DINERO F-B3.) Exige un SQLSTATE de una CLASE que existe en PostgreSQL (apéndice A: `00`…`9`x, `F0`, `HV`, `P0`, `XX`), no cualquier cinco
 * caracteres —`EPIPE`, `EBADF`, `ELOOP` y `ECONNRESET` son códigos de Node, no de la base— y que la severidad sea `ERROR`: un `FATAL`/`PANIC` (p. ej. `57P01`
 * terminación administrativa) puede llegar después de un COMMIT ya aplicado, y ahí NO se sabe.
 */
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;
export function isDefiniteDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && SQLSTATE.test(code) && severity === 'ERROR';
}
const LOST_LOCK_MESSAGE = 'Se perdió el bloqueo de la Idempotency-Key';

const invalid = (errors: FieldError[]) => new ProblemError('validation_failed', { errors });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * API pública de endpoints (`/webhook_endpoints`). Toda operación está acotada al comercio que el borde autenticó:
 * un endpoint de otro comercio es indistinguible de uno que no existe (404).
 */
@Injectable()
export class EndpointService {
  private readonly logger = new Logger(EndpointService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
    @Inject(TARGET_GUARD) private readonly guard: TargetGuard,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(IDEMPOTENCY) private readonly idempotency: IdempotencyStore,
  ) {}

  /** Valida el cuerpo de alta. Lista blanca de campos: lo no declarado se rechaza (asignación masiva). */
  private validateCreate(body: unknown): { url: string; enabledEvents: string[]; scheme: SignatureScheme; description: string | null } {
    if (!isRecord(body)) throw invalid([{ field: 'body', code: 'invalid_type' }]);
    const errors: FieldError[] = Object.keys(body).filter((key) => !CREATE_FIELDS.includes(key)).map((field) => ({ field, code: 'unknown_field' }));

    const { url, enabled_events: events, signature_scheme: scheme, description } = body;
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048) errors.push({ field: 'url', code: 'invalid_url' });
    if (!Array.isArray(events) || events.length < 1 || events.length > 50 || events.some((e) => typeof e !== 'string' || !EVENT_PATTERN.test(e))) {
      errors.push({ field: 'enabled_events', code: 'invalid_event_type' });
    } else {
      const unknown = (events as string[]).filter((e) => e !== '*' && !PUBLIC_EVENT_TYPES.includes(e));
      if (unknown.length > 0) errors.push({ field: 'enabled_events', code: 'unknown_event_type', message: 'Solo se pueden suscribir eventos públicos' });
    }
    if (scheme !== undefined && scheme !== 'v1' && scheme !== 'v1a') errors.push({ field: 'signature_scheme', code: 'invalid_value' });
    if (description !== undefined && (typeof description !== 'string' || description.length > 200)) errors.push({ field: 'description', code: 'invalid_value' });
    if (errors.length > 0) throw invalid(errors);

    return {
      url: url as string,
      enabledEvents: [...new Set(events as string[])],
      scheme: (scheme as SignatureScheme | undefined) ?? 'v1',
      description: typeof description === 'string' ? description : null,
    };
  }

  private async assertPublicTarget(url: string): Promise<void> {
    try {
      await this.guard.check(url);
    } catch (error) {
      if (error instanceof TargetRejectedError) throw invalid([{ field: 'url', code: error.reason }]);
      throw error;
    }
  }

  /**
   * Alta idempotente. El secreto se muestra UNA vez; para que una repetición con la misma `Idempotency-Key` devuelva lo mismo
   * sin dejar el secreto en claro en la tabla de idempotencia, se guarda SELLADO y se abre al responder.
   */
  async create(merchantId: string, idempotencyKey: string, body: unknown): Promise<Replayable<EndpointWithSecret | Record<string, unknown>>> {
    const result = await this.idempotency.execute(
      { scope: merchantId, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/webhook_endpoints', body }) },
      async (context) => {
        const input = this.validateCreate(body);
        await this.assertPublicTarget(input.url);
        if ((await countActiveEndpoints(this.pool, merchantId)) >= this.config.maxEndpointsPerMerchant) {
          throw new ProblemError('validation_failed', { errors: [{ field: 'endpoint', code: 'limit_reached' }] });
        }
        // El motor puede dejar algo FUERA de la transacción (un endpoint de Svix): `provisioned` marca que `provisionEndpoint` terminó bien.
        const provisioned: { record?: EndpointRecord } = {};
        let created;
        try {
          created = await context.atomic('endpoint_created', async (client) => {
            const record = await insertEndpoint(client, { id: `we_${randomBytes(10).toString('hex')}`, merchantId, url: input.url, description: input.description, enabledEvents: input.enabledEvents, signatureScheme: input.scheme });
            const { secret } = await this.engine.provisionEndpoint(client, record);
            provisioned.record = record;
            return { record, secret };
          });
        } catch (error) {
          if (provisioned.record) await this.compensateFailedProvision(provisioned.record, error);
          throw error;
        }
        return { status: 201, body: { ...toView(created.record), secret: this.box.seal(created.secret, this.replayContext(merchantId, idempotencyKey)) } };
      },
    );
    return this.openReplay(result, merchantId, idempotencyKey);
  }

  /**
   * El alta falló DESPUÉS de que el motor creó el endpoint fuera de la transacción (REVISION-DINERO F5). Solo se deshace si el fallo es DEFINITIVO
   * (CLAUDE.md, regla 11): el servidor respondió con un error de base de datos o se perdió el bloqueo de la clave, es decir, nunca hubo COMMIT, y la fila
   * tampoco existe. Un corte de conexión o cualquier error sin código del servidor es ambiguo (el COMMIT pudo aplicarse): NO se borra y lo resuelve el
   * reconciliador. Si el endpoint se borrara y la fila hubiera quedado, el comercio tendría un endpoint sin contraparte y con su secreto perdido.
   */
  private async compensateFailedProvision(record: EndpointRecord, error: unknown): Promise<void> {
    if (!this.engine.compensateProvision) return;
    const definitive = error instanceof Error && (error.message === LOST_LOCK_MESSAGE || isDefiniteDatabaseError(error));
    if (!definitive) {
      this.logger.warn({ endpoint_id: record.id, err: error instanceof Error ? error.name : 'desconocido' }, 'El alta falló con resultado ambiguo tras crear el endpoint en el motor: no se borra; lo resolverá la reconciliación');
      return;
    }
    try {
      const row = await this.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1', [record.id]);
      if ((row.rowCount ?? 0) > 0) return; // el alta sí se confirmó: el endpoint del motor es legítimo
      await this.engine.compensateProvision(record);
    } catch (compensationError) {
      this.logger.warn({ endpoint_id: record.id, err: compensationError instanceof Error ? compensationError.name : 'desconocido' }, 'No se pudo compensar el alta fallida; lo resolverá la reconciliación');
    }
  }

  async rotateSecret(merchantId: string, idempotencyKey: string, id: string): Promise<Replayable<EndpointWithSecret | Record<string, unknown>>> {
    const result = await this.idempotency.execute(
      { scope: merchantId, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/webhook_endpoints/${id}/rotate_secret` }) },
      async (context) => {
        const rotated = await context.atomic('secret_rotated', async (client) => {
          // Bloquea la fila: dos rotaciones simultáneas del mismo endpoint se serializan y no repiten la versión.
          await client.query('SELECT 1 FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, merchantId]);
          const record = await findOwnedEndpoint(client, id, merchantId);
          if (!record) throw new ProblemError('resource_not_found');
          const { secret } = await this.engine.rotateEndpointSecret(client, record);
          return { record, secret };
        });
        return { status: 200, body: { ...toView(rotated.record), secret: this.box.seal(rotated.secret, this.replayContext(merchantId, idempotencyKey)) } };
      },
    );
    return this.openReplay(result, merchantId, idempotencyKey);
  }

  async list(merchantId: string, limit: number, cursor: string | undefined): Promise<{ object: 'list'; has_more: boolean; next_cursor: string | null; data: EndpointView[] }> {
    let startingAfter: string | undefined;
    if (cursor !== undefined) {
      startingAfter = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!/^we_[a-z0-9]{10,40}$/.test(startingAfter)) throw invalid([{ field: 'starting_after', code: 'invalid_cursor' }]);
    }
    const page = await listEndpoints(this.pool, merchantId, limit, startingAfter);
    const last = page.data[page.data.length - 1];
    return { object: 'list', has_more: page.hasMore, next_cursor: page.hasMore && last ? Buffer.from(last.id).toString('base64url') : null, data: page.data.map(toView) };
  }

  /** Borrado lógico y definitivo: lo pendiente no se entrega. Repetirlo da 404 (el recurso ya no existe). */
  async remove(merchantId: string, id: string): Promise<void> {
    const record = await findOwnedEndpoint(this.pool, id, merchantId);
    if (!record) throw new ProblemError('resource_not_found');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await softDeleteEndpoint(client, id);
      await this.engine.removeEndpoint(client, record);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private replayContext(merchantId: string, key: string): string {
    return `idem:${merchantId}:${key}`;
  }

  private openReplay(result: { status: number; body: unknown; replayed: boolean }, merchantId: string, key: string): Replayable<EndpointWithSecret | Record<string, unknown>> {
    const body = result.body as Record<string, unknown>;
    if (result.status < 300 && typeof body.secret === 'string') {
      return { status: result.status, body: { ...body, secret: this.box.open(body.secret, this.replayContext(merchantId, key)) } as unknown as EndpointWithSecret, replayed: result.replayed };
    }
    return { status: result.status, body, replayed: result.replayed };
  }
}
