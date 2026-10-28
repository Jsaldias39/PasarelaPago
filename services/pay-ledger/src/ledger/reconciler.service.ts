import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransferFlags, type Transfer } from 'tigerbeetle-node';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database.module';
import { holdGroupId, toHex128, txGroupId } from './ids';
import { LEDGER_CONFIG, type LedgerConfig } from './ledger.config';
import { KEY_MODE_OF, type PayMode } from './mode';
import { TB_ENGINE, TigerBeetleEngine, legCodeName } from './tb-engine';

export type ReconciliationStatus = 'ok' | 'diverged' | 'failed' | 'skipped';

export interface OrphanLeg {
  readonly transferId: string;
  /** Nombre lógico si Postgres conoce la cuenta; si no, `tb:<id hex>` (el registro de la cuenta pudo deshacerse junto con la operación). */
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly amountMinor: string;
  readonly code: string;
  readonly step: 'plain' | 'pending' | 'post' | 'void';
  readonly appliedAt: string;
}

/** Operación que TigerBeetle aplicó y de la que Postgres no tiene NINGUNA fila. */
export interface OrphanGroup {
  readonly mode: PayMode;
  readonly groupId: string;
  readonly kind: 'transaction' | 'hold';
  readonly legs: readonly OrphanLeg[];
  readonly totalMinor: string;
  /**
   * Siempre `false`: del lado de TigerBeetle solo quedan ids (hashes) y la marca de grupo; el `business_ref` y el `attempt` que exige la fila de
   * Postgres solo los tiene el llamador. No se inventan: el huérfano se avisa y se retoma cuando el llamador reintenta con la misma clave.
   */
  readonly recoverable: false;
}

/** Retención que Postgres da por `pending` y de la que TigerBeetle ya aplicó la segunda fase (post/void). */
export interface ResolutionAhead {
  readonly mode: PayMode;
  readonly holdId: string;
  readonly action: 'post' | 'void';
  readonly transferId: string;
  readonly amountMinor: string;
}

export interface ReconciliationReport {
  readonly status: ReconciliationStatus;
  readonly trigger: 'startup' | 'interval' | 'manual';
  readonly mode: PayMode;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Transferencias de TigerBeetle leídas (solo las marcadas como de este despliegue y modo). */
  readonly scanned: number;
  readonly groups: number;
  readonly matched: number;
  readonly orphans: readonly OrphanGroup[];
  readonly resolutionAhead: readonly ResolutionAhead[];
  /** `skipped`: por qué no corrió. `failed`: qué falló (solo el nombre y el mensaje; nunca datos de personas). */
  readonly detail?: string;
}

export interface ReconcilerMetrics {
  runs: number;
  failures: number;
  skipped: number;
  /** Gauges del último recorrido COMPLETO (`ok` o `diverged`). */
  orphanGroups: number;
  orphanAmountMinor: string;
  resolutionAhead: number;
  lastRunAt: string | null;
  lastCompleteAt: string | null;
}

export interface ReconcileOptions {
  readonly trigger?: ReconciliationReport['trigger'];
  /** Lo más reciente que se mira: una transferencia más nueva puede estar a mitad de camino hacia Postgres. Por defecto `reconcileGraceMs` de la configuración. */
  readonly graceMs?: number;
  /** Cuánto hacia atrás se mira. 0 = toda la historia. Por defecto `reconcileLookbackMs` de la configuración. */
  readonly lookbackMs?: number;
  readonly now?: Date;
}

/** Margen del lado de Postgres sobre el inicio de la ventana: el reloj de TigerBeetle y el de la aplicación no son el mismo. */
const PG_WINDOW_MARGIN_MS = 10 * 60 * 1000;

interface KnownGroup {
  readonly family: 'transaction' | 'hold';
  readonly holdId?: string;
  readonly holdStatus?: string;
}

/**
 * Reconciliador de recuperación TigerBeetle → Postgres (CLAUDE.md reglas 5 y 11, propuesta 25).
 *
 * TigerBeetle aplica primero y Postgres registra después: si el proceso muere entre los dos (o el cliente nativo entrega tras un *timeout* lo que
 * había quedado en su cola), TigerBeetle queda POR DELANTE. El reintento del llamador con la misma clave lo resuelve solo (ids deterministas →
 * `exists`), pero si nadie reintenta queda dinero movido sin fila. Este job lo encuentra:
 *   1. lee de TigerBeetle SOLO las transferencias marcadas como de este despliegue y modo (ver `TransferMeta`);
 *   2. las agrupa por operación y busca la operación en Postgres;
 *   3. lo que no está se informa (log estructurado de nivel error + gauges) como **huérfano**; una retención que Postgres da por pendiente y que
 *      TigerBeetle ya resolvió, como **resolución adelantada**.
 *
 * **Solo lee.** No inserta, no actualiza y no borra nada en ninguno de los dos lados, ni asume nada: los registros de dinero son de solo-agregar y
 * un resultado ambiguo se conserva y se escala a una persona (regla 11). Reconstruir la fila de un huérfano es imposible con el esquema actual
 * (falta `business_ref`/`attempt`): ver docs/trabajo/ola-3/P2/PROPUESTAS.md #27. **Falla cerrado**: ante cualquier error de lectura el recorrido
 * se declara `failed` y no se informa ni «sin divergencias» ni huérfanos a medias.
 * Una sola réplica corre a la vez (candado de sesión de Postgres, por esquema y modo).
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> | undefined;
  /** Último recorrido, sea cual sea su resultado. */
  last: ReconciliationReport | undefined;
  readonly metrics: ReconcilerMetrics = { runs: 0, failures: 0, skipped: 0, orphanGroups: 0, orphanAmountMinor: '0', resolutionAhead: 0, lastRunAt: null, lastCompleteAt: null };

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
    @Inject(LEDGER_CONFIG) private readonly config: LedgerConfig,
  ) {}

  /** Recorre el modo del despliegue (`PAY_MODE`: sandbox ⇒ test, live ⇒ live). */
  runForDeployment(options: ReconcileOptions = {}): Promise<ReconciliationReport> {
    return this.reconcile(KEY_MODE_OF[this.config.payMode], options);
  }

  async reconcile(mode: PayMode, options: ReconcileOptions = {}): Promise<ReconciliationReport> {
    const startedAt = new Date();
    const trigger = options.trigger ?? 'manual';
    const finish = (status: ReconciliationStatus, rest: Partial<ReconciliationReport> = {}): ReconciliationReport => {
      const report: ReconciliationReport = { status, trigger, mode, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), scanned: 0, groups: 0, matched: 0, orphans: [], resolutionAhead: [], ...rest };
      this.record(report);
      return report;
    };
    if (this.inFlight) return finish('skipped', { detail: 'ya hay un recorrido en curso en este proceso' });

    const run = this.run(mode, startedAt, options, finish);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async run(mode: PayMode, startedAt: Date, options: ReconcileOptions, finish: (s: ReconciliationStatus, r?: Partial<ReconciliationReport>) => ReconciliationReport): Promise<ReconciliationReport> {
    let client: PoolClient | undefined;
    let locked = false;
    try {
      client = await this.pool.connect();
      const lock = await client.query<{ got: boolean }>(`SELECT pg_try_advisory_lock(hashtext('ledger:reconciler:' || current_schema() || ':' || $1)) AS got`, [mode]);
      locked = lock.rows[0].got;
      if (!locked) return finish('skipped', { detail: 'otra réplica está reconciliando' });

      const now = options.now ?? startedAt;
      const graceMs = options.graceMs ?? this.config.reconcileGraceMs;
      const lookbackMs = options.lookbackMs ?? this.config.reconcileLookbackMs;
      const untilNs = BigInt(Math.max(0, now.getTime() - graceMs)) * 1_000_000n;
      const sinceNs = lookbackMs > 0 ? BigInt(Math.max(0, now.getTime() - lookbackMs)) * 1_000_000n : 0n;

      // 1. TigerBeetle: la lectura completa o nada.
      const transfers = await this.tb.scanMarkedTransfers(mode, sinceNs, untilNs);
      const groups = new Map<string, Transfer[]>();
      for (const t of transfers) {
        if (t.user_data_128 === 0n) continue; // sin grupo no hay a qué operación atribuirla
        const key = toHex128(t.user_data_128);
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      // 2. Postgres: primero la ventana; solo lo que no aparece se busca en toda la historia (no se declara huérfano algo que está fuera de la ventana).
      let known = await this.knownGroups(client, mode, lookbackMs > 0 ? new Date(now.getTime() - lookbackMs - PG_WINDOW_MARGIN_MS) : null);
      let unmatched = [...groups.keys()].filter((key) => !known.has(key));
      if (unmatched.length > 0 && lookbackMs > 0) {
        known = await this.knownGroups(client, mode, null);
        unmatched = unmatched.filter((key) => !known.has(key));
      }

      // 3. Lo que falta, con los nombres de cuenta que Postgres conozca.
      const accountNames = await this.accountNames(client, mode, unmatched.flatMap((key) => (groups.get(key) as Transfer[]).flatMap((t) => [t.debit_account_id, t.credit_account_id])));
      const orphans = unmatched.map((key) => this.orphan(mode, key, groups.get(key) as Transfer[], accountNames)).sort((a, b) => a.groupId.localeCompare(b.groupId));
      const resolutionAhead: ResolutionAhead[] = [];
      for (const [key, list] of groups) {
        const row = known.get(key);
        if (row?.family !== 'hold' || row.holdStatus !== 'pending') continue;
        for (const t of list) {
          if ((t.flags & (TransferFlags.post_pending_transfer | TransferFlags.void_pending_transfer)) === 0) continue;
          resolutionAhead.push({ mode, holdId: row.holdId as string, action: (t.flags & TransferFlags.post_pending_transfer) !== 0 ? 'post' : 'void', transferId: toHex128(t.id), amountMinor: String(t.amount) });
        }
      }
      resolutionAhead.sort((a, b) => a.holdId.localeCompare(b.holdId));

      return finish(orphans.length + resolutionAhead.length === 0 ? 'ok' : 'diverged', {
        scanned: transfers.length,
        groups: groups.size,
        matched: groups.size - orphans.length,
        orphans,
        resolutionAhead,
      });
    } catch (error) {
      // Fail-closed: nada de lo leído a medias se interpreta.
      const err = error as Error;
      return finish('failed', { detail: `${err.name}: ${err.message}`.slice(0, 300) });
    } finally {
      if (client) {
        if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('ledger:reconciler:' || current_schema() || ':' || $1))`, [mode]).catch(() => undefined);
        client.release();
      }
    }
  }

  /** Las operaciones de Postgres (asientos y retenciones) indexadas por el grupo con el que se marcaron sus transferencias. `since` null = todas. */
  private async knownGroups(client: PoolClient, mode: PayMode, since: Date | null): Promise<Map<string, KnownGroup>> {
    const known = new Map<string, KnownGroup>();
    const where = since ? 'AND created_at >= $2' : '';
    const params = since ? [mode, since] : [mode];
    const txs = await client.query<{ business_ref: string; attempt: number }>(`SELECT business_ref, attempt FROM ledger_transactions WHERE mode = $1 ${where}`, params);
    for (const r of txs.rows) known.set(toHex128(txGroupId(mode, r.business_ref, r.attempt)), { family: 'transaction' });
    const holds = await client.query<{ id: string; business_ref: string; attempt: number; status: string }>(`SELECT id, business_ref, attempt, status FROM ledger_holds WHERE mode = $1 ${where}`, params);
    for (const r of holds.rows) known.set(toHex128(holdGroupId(mode, r.business_ref, r.attempt)), { family: 'hold', holdId: r.id, holdStatus: r.status });
    return known;
  }

  private async accountNames(client: PoolClient, mode: PayMode, ids: readonly bigint[]): Promise<Map<string, string>> {
    const hex = [...new Set(ids.map(toHex128))];
    if (hex.length === 0) return new Map();
    const rows = await client.query<{ tb_id: string; account: string }>('SELECT tb_id, account FROM ledger_accounts WHERE mode = $1 AND tb_id = ANY($2)', [mode, hex]);
    return new Map(rows.rows.map((r) => [r.tb_id, r.account]));
  }

  private orphan(mode: PayMode, groupId: string, list: readonly Transfer[], names: ReadonlyMap<string, string>): OrphanGroup {
    const name = (id: bigint) => names.get(toHex128(id)) ?? `tb:${toHex128(id)}`;
    const legs = [...list]
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
      .map((t): OrphanLeg => ({
        transferId: toHex128(t.id),
        debitAccount: name(t.debit_account_id),
        creditAccount: name(t.credit_account_id),
        amountMinor: String(t.amount),
        code: legCodeName(t.code) ?? `codigo_${t.code}`,
        step: (t.flags & TransferFlags.pending) !== 0 ? 'pending' : (t.flags & TransferFlags.post_pending_transfer) !== 0 ? 'post' : (t.flags & TransferFlags.void_pending_transfer) !== 0 ? 'void' : 'plain',
        appliedAt: new Date(Number(t.timestamp / 1_000_000n)).toISOString(),
      }));
    // Una retención suma su monto una vez (la pendiente); un post/void no mueve dinero nuevo.
    const total = legs.filter((l) => l.step === 'plain' || l.step === 'pending').reduce((sum, l) => sum + BigInt(l.amountMinor), 0n);
    return { mode, groupId, kind: legs.some((l) => l.step !== 'plain') ? 'hold' : 'transaction', legs, totalMinor: String(total), recoverable: false };
  }

  private record(report: ReconciliationReport): void {
    this.last = report;
    this.metrics.runs += 1;
    this.metrics.lastRunAt = report.finishedAt;
    if (report.status === 'skipped') {
      this.metrics.skipped += 1;
      return;
    }
    if (report.status === 'failed') {
      this.metrics.failures += 1;
      this.logger.error({ event: 'ledger.reconciliation.failed', mode: report.mode, trigger: report.trigger, detail: report.detail }, 'No se pudo reconciliar TigerBeetle con Postgres: no se concluyó nada de este recorrido');
      return;
    }
    this.metrics.lastCompleteAt = report.finishedAt;
    this.metrics.orphanGroups = report.orphans.length;
    this.metrics.orphanAmountMinor = String(report.orphans.reduce((sum, o) => sum + BigInt(o.totalMinor), 0n));
    this.metrics.resolutionAhead = report.resolutionAhead.length;
    if (report.status === 'diverged') {
      // Alerta sin datos personales: ids, nombres de cuenta lógica (ya van en el log del invariante), importes y estados.
      this.logger.error(
        {
          event: 'ledger.reconciliation.diverged',
          mode: report.mode,
          trigger: report.trigger,
          metric: { orphan_groups: report.orphans.length, orphan_amount_minor: this.metrics.orphanAmountMinor, resolution_ahead: report.resolutionAhead.length },
          orphans: report.orphans.slice(0, 20),
          resolutionAhead: report.resolutionAhead.slice(0, 20),
        },
        'TigerBeetle tiene operaciones que Postgres no registró: el reintento del llamador con la misma clave las adopta; si nadie reintenta, requieren a una persona',
      );
    }
  }

  start(intervalMs: number, runAtStart: boolean): void {
    if (this.timer) return;
    const tick = (trigger: 'startup' | 'interval') => void this.runForDeployment({ trigger }).catch(() => undefined);
    if (runAtStart) tick('startup');
    if (intervalMs > 0) {
      this.timer = setInterval(() => tick('interval'), intervalMs);
      this.timer.unref();
    }
  }

  /** Detiene el job y espera el recorrido en curso, para cerrar el pool y el cliente sin cortarlo. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }
}
