import type { Queryable } from '@pay/outbox';
import type { EndpointRecord } from '../endpoints/endpoint.types';

/** Un evento público ya filtrado por la política de payload, listo para entregar. */
export interface OutboundMessage {
  readonly merchantId: string;
  /** `id` del CloudEvent; es el `webhook-id` que ve el comercio y la clave de deduplicación. */
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
 * Motor de entrega de webhooks (P1.H3). El diseño pide Svix; hoy hay dos implementaciones del mismo contrato:
 * - `InProcessEngine` ([DOBLE de Svix]): firma, reintenta y registra entregas con Postgres. Corre de verdad en las pruebas.
 * - `SvixEngine`: adaptador al servidor Svix. Escrito contra la API documentada y SIN ejecutar (no hay Svix en este entorno).
 *
 * `db` es el cliente de la transacción del llamador: el motor en proceso escribe en la MISMA transacción (inbox + entregas
 * atómicos); un motor externo lo ignora y debe ser idempotente por `eventId`.
 */
export interface DeliveryEngine {
  readonly kind: 'in-process' | 'svix';
  /** Genera las credenciales de firma de un endpoint nuevo. */
  provisionEndpoint(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure>;
  /** Rota el secreto: desde ahora las entregas llevan la firma nueva Y la vieja hasta que venza la gracia. */
  rotateEndpointSecret(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure>;
  removeEndpoint(db: Queryable, endpoint: EndpointRecord): Promise<void>;
  /** Encola el mensaje para los endpoints suscriptos del comercio. Repetirlo no duplica nada. Devuelve cuántas entregas nuevas creó. */
  publish(db: Queryable, message: OutboundMessage): Promise<number>;
}

export const DELIVERY_ENGINE = Symbol('DELIVERY_ENGINE');
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
