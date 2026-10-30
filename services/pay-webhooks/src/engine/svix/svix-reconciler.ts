import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { disableEndpoint } from '../../endpoints/endpoint.repository';
import { SvixApiError, type SvixClient, type SvixEndpointOut } from './svix-client';
import { DEFAULT_SANDBOX_NAMESPACE, ORPHAN_REVIEW_KEY, ORPHAN_REVIEW_RELEASED, SVIX_OWNER_KEY, assertValidNamespace } from './svix-namespace';

/** Tope de borrados de huérfanos por pasada si no se configura otro. Bajo a propósito: un huérfano real es una rareza (un alta revertida). */
export const DEFAULT_MAX_ORPHAN_DELETES_PER_PASS = 5;

/**
 * Qué hace el reconciliador con un huérfano PROPIO (marca de este entorno, sin fila local) pasada la gracia:
 * - `disable` (POR DEFECTO, RE-REVISION-DINERO F-B1): lo DESHABILITA en Svix (`PATCH disabled`). Es reversible: el endpoint, su URL y su secreto siguen en
 *   Svix y se reactivan con el procedimiento de docs/runbooks/sandbox-a-produccion.md. Es lo seguro porque tras restaurar la base los endpoints creados
 *   DESPUÉS del punto de restauración también son «huérfanos» y son legítimos: borrarlos pierde el secreto del comercio para siempre.
 * - `delete`: lo BORRA (irreversible), siempre bajo el tope por pasada. Solo con configuración explícita (y, bajo `live`, con confirmación deliberada).
 */
export type OrphanAction = 'disable' | 'delete';

export interface SvixReconcilerOptions {
  /**
   * Un endpoint de Svix que nuestra tabla no conoce se borra solo si es más viejo que esto MÁS `clockMarginMs` (da tiempo a que termine un alta en
   * curso y absorbe el desfase entre el reloj de este servicio y el de Svix, que es quien fecha el endpoint).
   */
  readonly orphanGraceMs: number;
  /** Comercios reconciliados a la vez. */
  readonly concurrency: number;
  /** Margen que se resta a la marca de agua al consultar intentos, por el desfase de relojes entre este servicio y Svix. */
  readonly clockMarginMs?: number;
  /** Propietario de ESTE entorno (`svix-namespace.ts`): solo se borran huérfanos que lleven su marca. Por defecto el de sandbox. */
  readonly namespace?: string;
  /**
   * Tope de huérfanos que una pasada borra (en total, no por comercio). Si hay más candidatos, NO se borra ninguno y se avisa: tantos huérfanos
   * no son altas revertidas sino una base restaurada o un Svix compartido, y borrar es irreversible. `0` desactiva el borrado.
   */
  readonly maxOrphanDeletesPerPass?: number;
  /** Qué hacer con un huérfano propio pasada la gracia. Por defecto `disable` (reversible); `delete` solo con configuración explícita. */
  readonly orphanAction?: OrphanAction;
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
  /** Huérfanos propios que ESTA pasada deshabilitó en Svix (reversible). */
  readonly orphansDisabled: number;
  /** Huérfanos propios que ya estaban deshabilitados en Svix y se dejaron así (la pasada no hizo nada con ellos). */
  readonly orphansHeldDisabled: number;
  /** Huérfanos propios que una persona liberó a propósito (`metadata.pay_orphan_review = released`): se ignoran. */
  readonly orphansReleased: number;
  /** Huérfanos propios que SE HABRÍAN borrado y no se borraron porque la pasada superó el tope (`maxOrphanDeletesPerPass`). */
  readonly orphansWithheld: number;
  /** Endpoints `we_…` que nuestra tabla no conoce y que NO llevan la marca de este entorno (de otro entorno o anteriores a la marca): nunca se tocan. */
  readonly notOwnedUnknown: number;
  /** Endpoints de nuestra tabla que Svix no tiene (o cuya aplicación no existe): se registran, NO se recrean (el comercio perdería su secreto). */
  readonly missingInSvix: number;
  readonly errors: number;
}

const OWN_ENDPOINT_UID = /^we_[a-z0-9]{10,40}$/;
const DEFAULT_CLOCK_MARGIN_MS = 60_000;

interface OrphanCandidate {
  readonly merchantId: string;
  readonly uid: string;
  /** Ya estaba deshabilitado en Svix cuando se lo vio. */
  readonly disabled: boolean;
}

type OrphanTotals = { orphansDeleted: number; orphansDisabled: number; orphansHeldDisabled: number; orphansWithheld: number; errors: number };

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
 * - **Huérfanos:** un endpoint de Svix con forma `we_…` y la marca de ESTE entorno (`metadata.pay_owner`) que ya no existe aquí (un alta que Svix
 *   aceptó y cuya transacción se revirtió, O un alta posterior al punto de restauración de la base) se DESHABILITA en Svix pasado
 *   `orphanGraceMs + clockMarginMs`, tras comprobar de nuevo en la base (`orphanAction: 'disable'`, por defecto; reversible, con alerta). Sin esto seguiría
 *   recibiendo los eventos del comercio. El BORRADO (`orphanAction: 'delete'`) es irreversible —el secreto se pierde— y solo ocurre con configuración
 *   explícita y bajo el tope `maxOrphanDeletesPerPass`; si la pasada encuentra más candidatos que el tope (base restaurada) no borra NINGUNO y deshabilita.
 *   NUNCA se toca uno sin la marca (de otro entorno que comparte el Svix, o anterior a la marca) ni uno liberado por una persona (`pay_orphan_review`).
 *   Limitación (F-B4): solo se recorren los comercios con al menos un endpoint local; los huérfanos de un comercio sin ninguno no se miran.
 *
 * El 410 se busca en los últimos 100 intentos 4xx de cada endpoint desde la última pasada completa y sin errores. Es sondeo: una llamada
 * por endpoint habilitado y por ciclo. Ver PROPUESTAS.md para la alternativa por webhooks operativos de Svix a mayor escala.
 */
export class SvixReconciler {
  private readonly logger = new Logger(SvixReconciler.name);
  private watermark: Date | undefined;
  private readonly namespace: string;
  private readonly maxOrphanDeletes: number;
  private readonly orphanAction: OrphanAction;
  lastSummary: ReconcileSummary | undefined;
  /** Contadores acumulados desde el arranque; `/health` los expone. `orphanCapTrips` > 0 pide mirar por qué había tantos huérfanos. */
  readonly stats = { orphanCapTrips: 0, orphansWithheldTotal: 0 };
  /** Huérfanos propios deshabilitados: acumulado desde el arranque y los que están deshabilitados HOY (última pasada); `/health/ready` los expone. */
  readonly disabledStats = { disabledTotal: 0, heldDisabled: 0 };

  constructor(
    private readonly pool: Pool,
    private readonly client: SvixClient,
    private readonly options: SvixReconcilerOptions,
  ) {
    this.namespace = assertValidNamespace(options.namespace ?? DEFAULT_SANDBOX_NAMESPACE);
    const cap = options.maxOrphanDeletesPerPass ?? DEFAULT_MAX_ORPHAN_DELETES_PER_PASS;
    if (!Number.isInteger(cap) || cap < 0) throw new RangeError('maxOrphanDeletesPerPass debe ser un entero >= 0');
    this.maxOrphanDeletes = cap;
    const action = options.orphanAction ?? 'disable';
    if (action !== 'disable' && action !== 'delete') throw new RangeError("orphanAction debe ser 'disable' o 'delete'");
    this.orphanAction = action;
  }

  get action(): OrphanAction {
    return this.orphanAction;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async runOnce(): Promise<ReconcileSummary> {
    const started = this.now();
    const since = this.watermark ? new Date(this.watermark.getTime() - (this.options.clockMarginMs ?? DEFAULT_CLOCK_MARGIN_MS)) : undefined;
    const rows = await this.pool.query('SELECT id, merchant_id, status FROM webhook_endpoints WHERE deleted_at IS NULL ORDER BY merchant_id, id');
    const byMerchant = new Map<string, LocalEndpoint[]>();
    for (const row of rows.rows) {
      const endpoint: LocalEndpoint = { id: String(row.id), merchantId: String(row.merchant_id), status: row.status === 'disabled' ? 'disabled' : 'enabled' };
      byMerchant.set(endpoint.merchantId, [...(byMerchant.get(endpoint.merchantId) ?? []), endpoint]);
    }

    const totals = { merchants: byMerchant.size, endpoints: rows.rows.length, disabledGone: 0, disabledFailing: 0, alignedDisabled: 0, orphansDeleted: 0, orphansDisabled: 0, orphansHeldDisabled: 0, orphansReleased: 0, orphansWithheld: 0, notOwnedUnknown: 0, missingInSvix: 0, errors: 0 };
    const candidates: OrphanCandidate[] = [];
    const queue = [...byMerchant.entries()];
    const lanes = Array.from({ length: Math.max(1, Math.min(this.options.concurrency, queue.length)) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const part = await this.reconcileMerchant(next[0], next[1], since);
          totals.disabledGone += part.disabledGone;
          totals.disabledFailing += part.disabledFailing;
          totals.alignedDisabled += part.alignedDisabled;
          totals.notOwnedUnknown += part.notOwnedUnknown;
          totals.orphansReleased += part.orphansReleased;
          candidates.push(...part.orphanCandidates);
          totals.missingInSvix += part.missingInSvix;
          totals.errors += part.errors;
        } catch (error) {
          totals.errors += 1;
          this.logger.warn({ merchant_id: next[0], err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo reconciliar el comercio; se reintenta en el próximo ciclo');
        }
      }
    });
    await Promise.all(lanes);
    await this.handleOrphans(candidates, totals);

    // La marca de agua solo avanza tras una pasada limpia: un error deja la ventana anterior para que nada quede sin mirar.
    if (totals.errors === 0) this.watermark = started;
    this.lastSummary = totals;
    return totals;
  }

  private async reconcileMerchant(merchantId: string, local: readonly LocalEndpoint[], since: Date | undefined) {
    const part = { disabledGone: 0, disabledFailing: 0, alignedDisabled: 0, notOwnedUnknown: 0, orphansReleased: 0, missingInSvix: 0, errors: 0, orphanCandidates: [] as OrphanCandidate[] };
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

    // Huérfanos: solo se REÚNEN aquí; el borrado lo decide la pasada completa (`deleteOrphans`) porque el tope es por pasada, no por comercio.
    const known = new Set(local.map((e) => e.id));
    for (const svix of remote) {
      if (!svix.uid || !OWN_ENDPOINT_UID.test(svix.uid) || known.has(svix.uid)) continue;
      if (svix.metadata[SVIX_OWNER_KEY] !== this.namespace) {
        part.notOwnedUnknown += 1;
        continue;
      }
      // Una persona lo liberó a propósito (procedimiento del runbook): no es un huérfano a tratar, aunque siga sin fila local.
      if (svix.metadata[ORPHAN_REVIEW_KEY] === ORPHAN_REVIEW_RELEASED) {
        part.orphansReleased += 1;
        continue;
      }
      // La edad compara el reloj de Svix (createdAt) con el de este servicio: el margen absorbe el desfase en el sentido peligroso (Svix atrasado).
      if (this.now().getTime() - Date.parse(svix.createdAt) < this.options.orphanGraceMs + (this.options.clockMarginMs ?? DEFAULT_CLOCK_MARGIN_MS)) continue;
      part.orphanCandidates.push({ merchantId, uid: svix.uid, disabled: svix.disabled });
    }
    return part;
  }

  /**
   * Trata los huérfanos propios de la pasada. Antes de cada acción vuelve a mirar la base: la fila puede haberse confirmado después de la consulta del ciclo.
   *
   * - `disable` (defecto): deshabilita los que siguen habilitados en Svix (reversible), deja en paz los que ya lo están y avisa con `alert: true`.
   * - `delete`: borra (irreversible) si hay NO MÁS que el tope por pasada; si hay más, no borra NINGUNO (base restaurada o Svix compartido), avisa, lo cuenta
   *   y los deshabilita como en el modo seguro.
   */
  private async handleOrphans(candidates: readonly OrphanCandidate[], totals: OrphanTotals): Promise<void> {
    this.disabledStats.heldDisabled = 0;
    if (candidates.length === 0) return;
    let mode: OrphanAction = this.orphanAction;
    if (mode === 'delete' && candidates.length > this.maxOrphanDeletes) {
      totals.orphansWithheld = candidates.length;
      this.stats.orphanCapTrips += 1;
      this.stats.orphansWithheldTotal += candidates.length;
      this.logger.error(
        { candidates: candidates.length, cap: this.maxOrphanDeletes, namespace: this.namespace, alert: true },
        'Hay más endpoints huérfanos que el tope por pasada: no se borra ninguno (¿base restaurada o Svix compartido?) y se deshabilitan; requiere revisión humana',
      );
      mode = 'disable';
    }
    for (const orphan of candidates) {
      try {
        const still = await this.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1 AND deleted_at IS NULL', [orphan.uid]);
        if ((still.rowCount ?? 0) > 0) continue;
        if (mode === 'delete') {
          await this.client.deleteEndpoint(orphan.merchantId, orphan.uid);
          totals.orphansDeleted += 1;
          this.logger.warn({ merchant_id: orphan.merchantId, endpoint_id: orphan.uid }, 'Endpoint de Svix sin fila local: borrado (WEBHOOKS_SVIX_ORPHAN_ACTION=delete)');
        } else if (orphan.disabled) {
          totals.orphansHeldDisabled += 1;
          this.disabledStats.heldDisabled += 1;
        } else {
          await this.client.setEndpointDisabled(orphan.merchantId, orphan.uid, true);
          totals.orphansDisabled += 1;
          this.disabledStats.disabledTotal += 1;
          this.disabledStats.heldDisabled += 1;
          this.logger.error(
            { merchant_id: orphan.merchantId, endpoint_id: orphan.uid, namespace: this.namespace, alert: true },
            'Endpoint de Svix sin fila local (¿alta revertida o base restaurada?): DESHABILITADO, no borrado; si es legítimo, reactivarlo con el procedimiento del runbook',
          );
        }
      } catch (error) {
        totals.errors += 1;
        this.logger.warn({ merchant_id: orphan.merchantId, endpoint_id: orphan.uid, action: mode, err: error instanceof Error ? error.name : 'desconocido', svix_status: error instanceof SvixApiError ? error.status : undefined }, 'No se pudo tratar el endpoint huérfano');
      }
    }
  }
}
