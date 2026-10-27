import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseApiKey, verifyApiKey } from '@pay/api-key';
import { serviceHeaders } from '@pay/service-auth';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { EdgeProblemError, fail } from '../edge-problem';
import { RateLimiter } from '../rate-limiter';
import { ReplicaRepository } from '../replica/replica.repository';
import { matchRoute } from '../routes';
import { UpstreamClient } from './upstream.client';

/** Hash que nunca coincide: se compara igual cuando la clave no existe, para que el tiempo no delate qué claves existen. */
const DUMMY_HASH = `sha256$${'0'.repeat(64)}`;
const BEARER = /^Bearer ([^\s]+)$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/;
/** Cabeceras que el cliente NO puede fijar: las pone el borde con lo que autenticó. */
export const RESERVED_HEADERS = ['x-service-id', 'x-merchant-id', 'x-pay-mode'] as const;

export interface Principal {
  readonly merchantId: string;
  readonly keyId: string;
  readonly mode: 'test' | 'live';
}

/**
 * Tubería de toda petición pública, en este orden (cada paso corta con su error RFC 9457):
 * 1. límite por IP (antes de autenticar) y freno a quien falla mucho la autenticación;
 * 2. autenticación de la clave de API contra la réplica; el modo sale del REGISTRO, nunca del token;
 * 3. estado del comercio; 4. límite por clave; 5. ruta, consulta, `Idempotency-Key` y cuerpo según el contrato;
 * 6. reenvío al servicio dueño con la identidad del borde.
 * El borde no tiene lógica de negocio: no interpreta cuerpos ni respuestas exitosas.
 */
@Injectable()
export class EdgePipeline {
  private readonly logger = new Logger(EdgePipeline.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly replica: ReplicaRepository,
    private readonly limiter: RateLimiter,
    private readonly upstream: UpstreamClient,
  ) {}

  async handle(req: Request, res: Response): Promise<void> {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'desconocida';
    const { rateLimit } = this.config;

    await this.enforce(await this.limiter.hit(`ip:${ip}`, rateLimit.ipPerWindow));
    const failures = await this.limiter.peek(`authfail:${ip}`);
    if (failures !== null && failures >= rateLimit.authFailuresPerWindow) {
      throw fail('rate_limited', { headers: { 'Retry-After': String(rateLimit.windowSeconds) } });
    }

    const principal = await this.authenticate(req, ip);

    const merchant = await this.replica.merchantStatus(principal.merchantId);
    if (merchant === 'suspended' || merchant === 'closed') throw fail('merchant_suspended');

    await this.enforce(await this.limiter.hit(`key:${principal.keyId}`, rateLimit.keyPerWindow));

    const path = req.path.replace(/^\/v1(?=\/)/, '');
    const route = matchRoute(req.method, path);
    if (!route) throw fail('resource_not_found');

    const query = this.filterQuery(req, route.rule.query);
    const idempotencyKey = this.idempotencyKey(req, route.rule.idempotencyKey);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > this.config.maxBodyBytes) throw this.tooLarge();
    if (declared > 0 && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw fail('validation_failed', { errors: [{ field: 'content-type', code: 'unsupported_media_type', message: 'El cuerpo debe ser application/json' }] });
    }
    // El cuerpo se lee RECIÉN acá: después de autenticar, limitar y validar. Nada se bufferea de quien no se autenticó.
    const body = await this.readBody(req);

    const result = await this.upstream.forward({
      upstream: route.rule.upstream,
      method: req.method,
      path: route.path,
      query,
      body,
      headers: serviceHeaders('pay-edge', {
        'x-merchant-id': principal.merchantId,
        'x-pay-mode': principal.mode === 'test' ? 'sandbox' : 'live',
        'x-request-id': req.id !== undefined ? String(req.id) : undefined,
        traceparent: this.traceparent(req),
        'idempotency-key': idempotencyKey,
        'content-type': body.length > 0 ? 'application/json' : undefined,
        accept: 'application/json',
      }),
    });

    res.setHeader('Cache-Control', 'no-store');
    if (this.config.payMode === 'sandbox') res.setHeader('X-Pay-Mode', 'sandbox');
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.status(result.status).end(result.body);
  }

  private tooLarge(): EdgeProblemError {
    return fail('validation_failed', { errors: [{ field: 'body', code: 'too_large', message: `El cuerpo no puede superar ${this.config.maxBodyBytes} bytes` }] });
  }

  /** Lee el cuerpo crudo con tope (también con transferencia en trozos, donde no hay Content-Length). */
  private async readBody(req: Request): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.config.maxBodyBytes) throw this.tooLarge();
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async enforce(decision: Awaited<ReturnType<RateLimiter['hit']>>): Promise<void> {
    if (decision.status === 'unavailable') {
      // DT-1: sin Redis se deja pasar (disponibilidad) y se registra; la protección de abuso se degrada, no se cae el servicio.
      this.logger.error('Redis no responde: se omite el límite de velocidad');
      return;
    }
    if (decision.status === 'limited') throw fail('rate_limited', { headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  }

  private async authenticate(req: Request, ip: string): Promise<Principal> {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    const parsed = parseApiKey(token);
    const record = parsed ? await this.replica.findKey(parsed.keyId) : undefined;
    // El modo con el que se verifica y se enruta sale del registro replicado de la clave, NUNCA del token (que el cliente controla).
    const stored = record?.keyHash ? { keyId: record.keyId, mode: record.mode, keyHash: record.keyHash } : { keyId: parsed?.keyId ?? 'key_unknown', mode: parsed?.mode ?? ('test' as const), keyHash: DUMMY_HASH };
    const hashOk = parsed ? verifyApiKey(token, stored) : false;
    const allowedMode = this.config.payMode === 'live' ? 'live' : 'test';

    if (!parsed || !record || !record.keyHash || !hashOk || record.revoked || record.mode !== allowedMode) {
      await this.limiter.hit(`authfail:${ip}`, Number.MAX_SAFE_INTEGER);
      // Una sola respuesta para clave inexistente, mal formada, revocada o de otro modo: no se distingue (no se filtra qué existe).
      throw fail('unauthorized', { headers: { 'WWW-Authenticate': 'Bearer realm="pay"' } });
    }
    return { merchantId: record.merchantId, keyId: record.keyId, mode: record.mode };
  }

  private filterQuery(req: Request, allowed: readonly string[]): string {
    const params = new URLSearchParams();
    const errors: { field: string; code: string }[] = [];
    for (const [name, value] of Object.entries(req.query)) {
      if (!allowed.includes(name)) errors.push({ field: name, code: 'unknown_parameter' });
      else if (typeof value !== 'string') errors.push({ field: name, code: 'invalid_parameter' });
      else params.set(name, value);
    }
    if (errors.length > 0) throw fail('validation_failed', { errors });
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  private idempotencyKey(req: Request, required: boolean): string | undefined {
    const value = req.headers['idempotency-key'];
    if (value === undefined) {
      if (required) throw fail('idempotency_key_required');
      return undefined;
    }
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
      throw fail('validation_failed', { errors: [{ field: 'idempotency-key', code: 'invalid_format', message: 'De 8 a 255 caracteres ASCII imprimibles' }] });
    }
    return value;
  }

  /** Continúa la traza del cliente si trae una válida (mismo trace id, span nuevo); si no, abre una. */
  private traceparent(req: Request): string {
    const incoming = TRACEPARENT.exec(String(req.headers.traceparent ?? ''));
    const traceId = incoming && !/^0+$/.test(incoming[1]) ? incoming[1] : randomBytes(16).toString('hex');
    const flags = incoming ? incoming[2] : '01';
    return `00-${traceId}-${randomBytes(8).toString('hex')}-${flags}`;
  }
}

export { EdgeProblemError };
