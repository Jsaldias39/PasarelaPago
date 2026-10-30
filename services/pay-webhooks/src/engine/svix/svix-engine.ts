import { Logger } from '@nestjs/common';
import type { Queryable } from '@pay/outbox';
import { generateKeyPair, generateSecret } from '@pay/webhook-signature';
import { enabledEndpointsFor } from '../../endpoints/endpoint.repository';
import type { EndpointRecord } from '../../endpoints/endpoint.types';
import { PUBLIC_EVENT_TYPES } from '../../events/public-events';
import { EngineRejectedError, type DeliveryEngine, type OutboundMessage, type SecretDisclosure } from '../delivery-engine';
import { SvixApiError, SvixUnavailableError, type SvixClient } from './svix-client';

export interface SvixEngineOptions {
  /** Cuánto siguen firmándose las entregas con el secreto viejo tras rotar. Svix admite de 0 a 7 días. */
  readonly rotationGraceSeconds: number;
  /** Veces que se reintenta una rotación de resultado ambiguo (se verifica el estado antes de repetirla). */
  readonly rotateAttempts?: number;
}

/** Svix acepta de 0 a 7 días de gracia (OpenAPI `EndpointSecretRotateIn.gracePeriodSeconds`). */
export const SVIX_MAX_GRACE_SECONDS = 7 * 24 * 3600;

/** Claves de un endpoint nuevo o rotado: lo que se le manda a Svix, lo que se le muestra al comercio y cómo comprobar el estado. */
interface KeyMaterial {
  /** `whsec_…` (v1) o `whsk_…` (v1a): lo que Svix guarda y con lo que firma. */
  readonly forSvix: string;
  /** Lo que se le muestra UNA vez al comercio: `whsec_…` o la pública `whpk_…`. */
  readonly disclosure: string;
}

function newKeyMaterial(scheme: EndpointRecord['signatureScheme']): KeyMaterial {
  if (scheme === 'v1a') {
    const pair = generateKeyPair();
    return { forSvix: pair.secretKey, disclosure: pair.publicKey };
  }
  const secret = generateSecret();
  return { forSvix: secret, disclosure: secret };
}

/**
 * Adaptador al servidor Svix (`WEBHOOKS_ENGINE=svix`). Mapeo, verificado contra svix-server 1.104.0:
 *
 * | Nuestro modelo                | Svix                                                                                      |
 * |-------------------------------|-------------------------------------------------------------------------------------------|
 * | comercio `mc_…`               | aplicación con `uid = mc_…` (`POST /app?get_if_exists=true`)                              |
 * | `webhook_endpoints.id` `we_…` | endpoint con `uid = we_…`, `url`, `eventTypes` (`null` si `*`) y la clave que generamos     |
 * | evento público (CloudEvent)   | mensaje `POST /app/{mc}/msg` con `eventId = id del CloudEvent`                            |
 * | rotación de secreto           | `POST …/secret/rotate` con la clave nueva y la gracia: las entregas llevan las dos firmas |
 * | baja                          | `DELETE …/endpoint/{we}`                                                                  |
 *
 * Quien firma, reintenta y registra los intentos es Svix. Las claves las GENERAMOS acá con `@pay/webhook-signature` y se las pasamos a
 * Svix (en vez de pedirle que las genere): así el esquema `v1a` (Ed25519) se conserva en la rotación y la clave que se le muestra al
 * comercio es, por construcción, la que Svix usa (se comprueba releyéndola). Svix las guarda cifradas con su `SVIX_MAIN_SECRET`; este
 * servicio NO las guarda en ninguna tabla.
 *
 * Idempotencia: el `eventId` de un mensaje es único (409 si se repite). El OpenAPI dice «en todo el entorno»; en 1.104.0 se observó que lo es
 * POR APLICACIÓN (el mismo `eventId` en dos comercios crea dos mensajes). Un 409 al publicar se resuelve consultando el mensaje por `eventId` en
 * la aplicación del comercio: si está ahí, ya se creó (éxito, 0 entregas nuevas); si no (solo ocurriría en un Svix que lo haga único por entorno),
 * es un choque con OTRO comercio y se rechaza de forma definitiva. Un timeout, un corte o un 5xx NO prueban que no se creó: se reintenta con el MISMO
 * `eventId` y, si no se resuelve, el error sube para que NATS reentregue (CLAUDE.md, regla 11).
 */
export class SvixEngine implements DeliveryEngine {
  readonly kind = 'svix' as const;
  private readonly logger = new Logger(SvixEngine.name);
  private eventTypesReady: Promise<void> | undefined;

  constructor(
    private readonly client: SvixClient,
    private readonly options: SvixEngineOptions,
  ) {
    if (!Number.isInteger(options.rotationGraceSeconds) || options.rotationGraceSeconds < 0 || options.rotationGraceSeconds > SVIX_MAX_GRACE_SECONDS) {
      throw new RangeError('La gracia de rotación de Svix debe estar entre 0 y 7 días');
    }
  }

  async provisionEndpoint(_db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure> {
    await this.ensureEventTypes();
    await this.client.ensureApp(endpoint.merchantId, endpoint.merchantId);
    const keys = newKeyMaterial(endpoint.signatureScheme);
    try {
      await this.client.createEndpoint(endpoint.merchantId, {
        uid: endpoint.id,
        url: endpoint.url,
        eventTypes: endpoint.enabledEvents.includes('*') ? null : endpoint.enabledEvents,
        secret: keys.forSvix,
      });
    } catch (error) {
      // 409: ya existe un endpoint con este `uid`. Si lo creó una llamada anterior de ESTA misma operación cuya respuesta se perdió, la
      // clave que guarda es la nuestra y la operación se da por hecha; si es de otro origen, es un conflicto real.
      if (!(error instanceof SvixApiError && error.status === 409)) throw error;
      if ((await this.client.getEndpointKey(endpoint.merchantId, endpoint.id)) !== keys.disclosure) throw error;
    }
    return { secret: keys.disclosure };
  }

  async rotateEndpointSecret(_db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure> {
    const keys = newKeyMaterial(endpoint.signatureScheme);
    const attempts = this.options.rotateAttempts ?? 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.client.rotateSecret(endpoint.merchantId, endpoint.id, keys.forSvix, this.options.rotationGraceSeconds);
        return { secret: keys.disclosure };
      } catch (error) {
        if (!(error instanceof SvixUnavailableError)) throw error;
        // Resultado ambiguo: la rotación pudo aplicarse. Se mira el estado real antes de repetirla; repetirla a ciegas empujaría la
        // misma clave dos veces a la lista de claves vigentes.
        let current: string | undefined;
        try {
          current = await this.client.getEndpointKey(endpoint.merchantId, endpoint.id);
        } catch (readError) {
          if (!(readError instanceof SvixUnavailableError)) throw readError;
        }
        if (current === keys.disclosure) return { secret: keys.disclosure };
        if (attempt >= attempts) throw error;
      }
    }
  }

  async removeEndpoint(_db: Queryable, endpoint: EndpointRecord): Promise<void> {
    await this.client.deleteEndpoint(endpoint.merchantId, endpoint.id);
  }

  async publish(db: Queryable, message: OutboundMessage): Promise<number> {
    // Los suscriptores se deciden con NUESTRA tabla (la autoridad de qué endpoints están habilitados); Svix filtra por tipo con lo mismo.
    const endpoints = await enabledEndpointsFor(db, message.merchantId, message.eventType);
    if (endpoints.length === 0) return 0;

    const payload = parsePayloadObject(message.payload);
    let outcome: 'created' | 'exists';
    try {
      outcome = await this.client.createMessage(message.merchantId, { eventId: message.eventId, eventType: message.eventType, payload });
    } catch (error) {
      if (error instanceof SvixApiError && (error.status === 422 || error.status === 400)) {
        this.logger.error({ event_id: message.eventId, type: message.eventType, svix_status: error.status, svix_code: error.code }, 'Svix rechazó el mensaje de forma definitiva');
        throw new EngineRejectedError('rejected_by_engine');
      }
      throw error;
    }
    if (outcome === 'created') return endpoints.length;

    // 409: ¿es este mismo evento (ya creado, p. ej. tras una caída entre Svix y el commit del inbox) o un `eventId` ajeno?
    const existing = await this.client.getMessage(message.merchantId, message.eventId);
    if (existing && existing.eventId === message.eventId) return 0;
    this.logger.error({ event_id: message.eventId, type: message.eventType }, 'Svix respondió 409 pero el mensaje no está en la aplicación del comercio');
    throw new EngineRejectedError('event_id_conflict');
  }

  /** Svix exige que el tipo exista antes de suscribir un endpoint a él. Se registran los públicos una vez por proceso (409 = ya estaba). */
  private ensureEventTypes(): Promise<void> {
    this.eventTypesReady ??= (async () => {
      for (const type of PUBLIC_EVENT_TYPES) await this.client.ensureEventType(type, `Evento público ${type}`);
    })().catch((error: unknown) => {
      this.eventTypesReady = undefined;
      throw error;
    });
    return this.eventTypesReady;
  }
}

/** El cuerpo ya pasó la política de payload (siempre un objeto JSON); si no lo es, nunca se podrá entregar. */
function parsePayloadObject(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new EngineRejectedError('payload_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new EngineRejectedError('payload_invalid');
  return parsed as Record<string, unknown>;
}
