import type { Queryable } from '@pay/outbox';
import type { EndpointRecord } from '../endpoints/endpoint.types';

/** Un evento público ya filtrado por la política de payload, listo para entregar. */
export interface OutboundMessage {
  readonly merchantId: string;
  /**
   * `id` del CloudEvent: la clave de deduplicación. Con el motor en proceso es además el `webhook-id` que ve el comercio; con Svix es el
   * `eventId` del mensaje y el `webhook-id` lo asigna Svix (`msg_…`, estable en los reintentos): ver docs/trabajo/ola-5/P1/PROPUESTAS.md.
   */
  readonly eventId: string;
  readonly eventType: string;
  /** Cuerpo JSON exacto (los bytes que se firman y se envían). */
  readonly payload: string;
}

/** Lo que se le muestra UNA sola vez al comercio: `whsec_…` (v1) o la clave pública `whpk_…` (v1a). */
export interface SecretDisclosure {
  readonly secret: string;
}

/**
 * Motor de entrega de webhooks (P1.H3). Hay dos implementaciones del mismo contrato (`test/engine-contract.ts` las ejercita a las dos):
 * - `InProcessEngine` ([DOBLE de Svix]): firma, reintenta y registra entregas con Postgres. Es el motor del modo sandbox sin Svix.
 * - `SvixEngine` (`WEBHOOKS_ENGINE=svix`): adaptador al servidor Svix (REST). Verificado contra svix-server 1.104.0 REAL
 *   (`test/svix/`). Svix es quien firma, reintenta y registra intentos; este servicio traduce endpoints y eventos.
 *
 * `db` es el cliente de la transacción del llamador: el motor en proceso escribe en la MISMA transacción (inbox + entregas
 * atómicos); un motor externo solo lo usa para leer y debe ser idempotente por `eventId`.
 */
export interface DeliveryEngine {
  readonly kind: 'in-process' | 'svix';
  /** Genera las credenciales de firma de un endpoint nuevo. */
  provisionEndpoint(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure>;
  /** Rota el secreto: desde ahora las entregas llevan la firma nueva Y la vieja hasta que venza la gracia. */
  rotateEndpointSecret(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure>;
  removeEndpoint(db: Queryable, endpoint: EndpointRecord): Promise<void>;
  /**
   * Encola el mensaje para los endpoints suscriptos del comercio. Repetirlo no duplica nada. Devuelve cuántas entregas nuevas creó.
   * @throws EngineRejectedError si el mensaje NUNCA se podrá entregar (reintentar no sirve); cualquier otro error es transitorio.
   */
  publish(db: Queryable, message: OutboundMessage): Promise<number>;
}

export type EngineRejection = 'payload_invalid' | 'event_id_conflict' | 'rejected_by_engine';

/** El motor rechazó el mensaje de forma definitiva: el consumidor lo descarta (no se reintenta) y lo cuenta. */
export class EngineRejectedError extends Error {
  constructor(readonly reason: EngineRejection) {
    super(`Mensaje rechazado por el motor de entrega: ${reason}`);
    this.name = 'EngineRejectedError';
  }
}

export const DELIVERY_ENGINE = Symbol('DELIVERY_ENGINE');
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
