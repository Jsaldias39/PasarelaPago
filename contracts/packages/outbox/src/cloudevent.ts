import { randomUUID } from 'node:crypto';

/**
 * Sobre de todo evento de la pasarela: CloudEvents 1.0, modo estructurado JSON.
 * Esquema: `contracts/schemas/cloudevent.schema.json`. `data` lleva solo ids y montos, nunca datos personales
 * ni de tarjeta (regla 6 del CLAUDE.md).
 */
export interface CloudEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly specversion: '1.0';
  /** UUID. También es el `Nats-Msg-Id` y la clave del inbox de los consumidores. */
  readonly id: string;
  /** Servicio que lo emite, por ejemplo `/pay-payments`. */
  readonly source: string;
  /** Tipo jerárquico con puntos, por ejemplo `payment_intent.succeeded`. */
  readonly type: string;
  readonly subject?: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: T;
  /** Extensión de CloudEvents para trazas distribuidas (W3C Trace Context). */
  readonly traceparent?: string;
  /** Extensión propia: comercio al que pertenece el evento. */
  readonly merchantid?: string;
}

export interface NewCloudEvent<T extends Record<string, unknown>> {
  readonly source: string;
  readonly type: string;
  readonly data: T;
  readonly subject?: string;
  readonly traceparent?: string;
  readonly merchantId?: string;
  /** Solo para pruebas y reintentos deterministas. */
  readonly id?: string;
  readonly time?: Date;
}

/** Construye un evento válido contra el esquema. */
export function newCloudEvent<T extends Record<string, unknown>>(input: NewCloudEvent<T>): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    ...(input.subject !== undefined && { subject: input.subject }),
    time: (input.time ?? new Date()).toISOString(),
    datacontenttype: 'application/json',
    data: input.data,
    ...(input.traceparent !== undefined && { traceparent: input.traceparent }),
    ...(input.merchantId !== undefined && { merchantid: input.merchantId }),
  };
}
