import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { disableEndpoint } from '../../endpoints/endpoint.repository';
import { SvixApiError, type SvixClient, type SvixEndpointOut } from './svix-client';

export interface SvixReconcilerOptions {
  /** Un endpoint de Svix que nuestra tabla no conoce se borra solo si es más viejo que esto (da tiempo a que termine un alta en curso). */
  readonly orphanGraceMs: number;
  /** Comercios reconciliados a la vez. */
  readonly concurrency: number;
  /** Margen que se resta a la marca de agua al consultar intentos, por el desfase de relojes entre este servicio y Svix. */
  readonly clockMarginMs?: number;
  readonly now?: () => Date;
}

export interface ReconcileSummary {
  readonly merchants: number;
  readonly endpoints: number;
  /** Deshabilitados por un 410 del receptor (`gone_410`). */
  readonly disabledGone: number;
  /** Deshabilitados porque Svix los dio de baja tras fallar durante `SVIX_ENDPOINT_FAILURE_DISABLE_AFTER` (`too_many_failures`). */
  readonly disabledFailing: number;
  /** Endpoints locales deshabilitados que Svix todavía tenía habilitados y se alinearon. */
  readonly alignedDisabled: number;
  readonly orphansDeleted: number;
  /** Endpoints de nuestra tabla que Svix no tiene (o cuya aplicación no existe): se registran, NO se recrean (el comercio perdería su secreto). */
  readonly missingInSvix: number;
  readonly errors: number;
}

const OWN_ENDPOINT_UID = /^we_[a-z0-9]{10,40}$/;

interface LocalEndpoint {
  readonly id: string;
  readonly merchantId: string;
  readonly status: 'enabled' | 'disabled';
}

/**
 * Reconcilia el estado de entrega que vive en Svix con el de nuestra tabla `webhook_endpoints` (P1.H3.M1/M4):
 *
 * - **410 ⇒ deshabilitado (REQ-P1-6).** Svix trata un 410 como cualquier fallo y sigue reintentando (observado en 1.104.0); este servicio mira los
 *   intentos con respuesta 4xx de cada endpoint habilitado y, si hay un 410, primero lo deshabilita en Svix (que descarta lo pendiente) y
 *   después marca `gone_410` en la tabla. Si el segundo paso falla, el siguiente ciclo repite el primero (idempotente) y completa el segundo.
 * - **Svix lo dio de baja** (`disabled` sin 410) ⇒ `too_many_failures`. El criterio de Svix es de TIEMPO (fallando de forma continua durante
 *   `SVIX_ENDPOINT_FAILURE_DISABLE_AFTER`), no «5 entregas agotadas seguidas» como el motor en proceso: es otro umbral (ver PROPUESTAS.md).
 * - **Convergencia inversa:** un endpoint deshabilitado aquí se deshabilita también en Svix si seguía activo.
 * - **Huérfanos:** un endpoint de Svix con forma `we_…` que ya no existe aquí (un alta que Svix aceptó y cuya transacción se revirtió)
 *   se borra pasado `orphanGraceMs`, tras comprobar de nuevo en la base. Sin esto seguiría recibiendo los eventos del comercio.
 *
 * El 410 se busca en los últimos 100 intentos 4xx de cada endpoint desde la última pasada completa y sin errores. Es sondeo: una llamada
 * por endpoint habilitado y por ciclo. Ver PROPUESTAS.md para la alternativa por webhooks operativos de Svix a mayor escala.
 */
export class SvixReconciler {
  private readonly logger = new Logger(SvixReconciler.name);
  private watermark: Date | undefined;
  lastSummary: ReconcileSummary | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly client: SvixClient,
    private readonly options: SvixReconcilerOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async runOnce(): Promise<ReconcileSummary> {
    const started = this.now();
    const since = this.watermark ? new Date(this.watermark.getTime() - (this.options.clockMarginMs ?? 60_000)) : undefined;
    const rows = await this.pool.query('SELECT id, merchant_id, status FROM webhook_endpoints WHERE deleted_at IS NULL ORDER BY merchant_id, id');
    const byMerchant = new Map<string, LocalEndpoint[]>();
    for (const row of rows.rows) {
      const endpoint: LocalEndpoint = { id: String(row.id), merchantId: String(row.merchant_id), status: row.status === 'disabled' ? 'disabled' : 'enabled' };
      byMerchant.set(endpoint.merchantId, [...(byMerchant.get(endpoint.merchantId) ?? []), endpoint]);
    }

    const totals = { merchants: byMerchant.size, endpoints: rows.rows.length, disabledGone: 0, disabledFailing: 0, alignedDisabled: 0, orphansDeleted: 0, missingInSvix: 0, errors: 0 };
    const queue = [...byMerchant.entries()];
    const lanes = Array.from({ length: Math.max(1, Math.min(this.options.concurrency, queue.length)) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const part = await this.reconcileMerchant(next[0], next[1], since);
          totals.disabledGone += part.disabledGone;
          totals.disabledFailing += part.disabledFailing;
          totals.alignedDisabled += part.alignedDisabled;
          totals.orphansDeleted += part.orphansDeleted;
          totals.missingInSvix += part.missingInSvix;
          totals.errors += part.errors;
        } catch (error) {
          totals.errors += 1;
          this.logger.warn({ merchant_id: next[0], err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo reconciliar el comercio; se reintenta en el próximo ciclo');
        }
      }
    });
    await Promise.all(lanes);

    // La marca de agua solo avanza tras una pasada limpia: un error deja la ventana anterior para que nada quede sin mirar.
    if (totals.errors === 0) this.watermark = started;
    this.lastSummary = totals;
    return totals;
  }

  private async reconcileMerchant(merchantId: string, local: readonly LocalEndpoint[], since: Date | undefined) {
    const part = { disabledGone: 0, disabledFailing: 0, alignedDisabled: 0, orphansDeleted: 0, missingInSvix: 0, errors: 0 };
    const remote = await this.client.listEndpoints(merchantId);
    if (!remote) {
      part.missingInSvix += local.length;
      this.logger.error({ merchant_id: merchantId, endpoints: local.length }, 'La aplicación del comercio no existe en Svix: deriva, requiere intervención (no se recrea)');
      return part;
    }
    const remoteByUid = new Map<string, SvixEndpointOut>(remote.flatMap((e) => (e.uid ? [[e.uid, e] as [string, SvixEndpointOut]] : [])));

    for (const endpoint of local) {
      const svix = remoteByUid.get(endpoint.id);
      if (!svix) {
        part.missingInSvix += 1;
        this.logger.error({ merchant_id: merchantId, endpoint_id: endpoint.id }, 'El endpoint no existe en Svix: deriva, requiere intervención (no se recrea)');
        continue;
      }
      try {
        if (endpoint.status === 'disabled') {
          if (!svix.disabled) {
            await this.client.setEndpointDisabled(merchantId, endpoint.id, true);
            part.alignedDisabled += 1;
          }
          continue;
        }
        const gone = (await this.client.listClientErrorAttempts(merchantId, endpoint.id, { ...(since ? { after: since } : {}), limit: 100 })).some((a) => a.responseStatusCode === 410);
        if (gone) {
          if (!svix.disabled) await this.client.setEndpointDisabled(merchantId, endpoint.id, true);
          await disableEndpoint(this.pool, endpoint.id, 'gone_410');
          part.disabledGone += 1;
          this.logger.warn({ merchant_id: merchantId, endpoint_id: endpoint.id }, 'El receptor respondió 410: endpoint deshabilitado');
        } else if (svix.disabled) {
          await disableEndpoint(this.pool, endpoint.id, 'too_many_failures');
          part.disabledFailing += 1;
          this.logger.warn({ merchant_id: merchantId, endpoint_id: endpoint.id }, 'Svix dio de baja el endpoint por fallos continuos: endpoint deshabilitado');
        }
      } catch (error) {
        part.errors += 1;
        this.logger.warn({ merchant_id: merchantId, endpoint_id: endpoint.id, err: error instanceof Error ? error.name : 'desconocido', svix_status: error instanceof SvixApiError ? error.status : undefined }, 'No se pudo reconciliar el endpoint');
      }
    }

    const known = new Set(local.map((e) => e.id));
    for (const svix of remote) {
      if (!svix.uid || !OWN_ENDPOINT_UID.test(svix.uid) || known.has(svix.uid)) continue;
      if (this.now().getTime() - Date.parse(svix.createdAt) < this.options.orphanGraceMs) continue;
      try {
        // Última comprobación antes de borrar algo en un sistema compartido: la fila puede haberse confirmado después de la consulta del ciclo.
        const still = await this.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1 AND deleted_at IS NULL', [svix.uid]);
        if ((still.rowCount ?? 0) > 0) continue;
        await this.client.deleteEndpoint(merchantId, svix.uid);
        part.orphansDeleted += 1;
        this.logger.warn({ merchant_id: merchantId, endpoint_id: svix.uid }, 'Endpoint de Svix sin fila local (alta revertida): borrado');
      } catch (error) {
        part.errors += 1;
        this.logger.warn({ merchant_id: merchantId, endpoint_id: svix.uid, err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo borrar el endpoint huérfano');
      }
    }
    return part;
  }
}
