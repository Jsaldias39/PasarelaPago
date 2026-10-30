import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Guardianes de SOLO-AGREGAR (REVISION-DINERO F-D1). El DDL del modelo crea, por cada tabla de solo-agregar, un trigger `<tabla>_immutable` (BEFORE UPDATE OR DELETE, por fila) y
 * un trigger `<tabla>_no_truncate` (BEFORE TRUNCATE) que llaman a `forbid_mutation()`. Solo existen en bases creadas con el DDL nuevo: `platform/scripts/sandbox-migrate.mjs` no toca una base
 * que ya tiene tablas, así que una base desplegada antes puede carecer de ellos sin que nada lo avise. Este chequeo lo hace visible en `/health/ready` (`checks.append_only_guards`);
 * bajo `PAY_MODE=live` un guardián ausente deja al servicio NO LISTO (503). El procedimiento para bases ya creadas está en `docs/runbooks/sandbox-a-produccion.md`.
 *
 * Mismo nombre y forma en pay-ledger, pay-settlement, pay-vault, pay-connectors y pay-webhooks (cada servicio tiene su copia: no comparten código).
 */
export const APPEND_ONLY_TABLES: readonly string[] = ['reveal_audit'];

export interface AppendOnlyGuardsReport {
  readonly ok: boolean;
  /** Nombres de los triggers esperados que NO están (inexistentes, deshabilitados, solo en modo réplica o con otro evento/función). Vacío si `ok`. */
  readonly missing: string[];
}

/** `pg_trigger.tgtype`: bit 1 = por fila, 2 = BEFORE, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE. */
const IMMUTABLE_TYPE = 1 + 2 + 8 + 16;
const NO_TRUNCATE_TYPE = 2 + 32;

const expectedGuards = (tables: readonly string[]): { table: string; name: string; type: number }[] =>
  tables.flatMap((table) => [
    { table, name: `${table}_immutable`, type: IMMUTABLE_TYPE },
    { table, name: `${table}_no_truncate`, type: NO_TRUNCATE_TYPE },
  ]);

/**
 * Consulta `pg_trigger` por los triggers que DEBEN proteger las tablas de solo-agregar de este servicio (en el esquema que resuelve el `search_path` de la conexión).
 * Un trigger cuenta solo si está habilitado para la sesión normal (`O`/`A`), llama a `forbid_mutation()` y tiene el evento esperado: uno apagado con `ALTER TABLE … DISABLE TRIGGER` falta.
 * Si la consulta falla (no se puede verificar) el resultado es FAIL-CLOSED: `ok: false` con todos los guardianes como faltantes.
 */
export async function checkAppendOnlyGuards(pool: Pick<Pool, 'query'>, tables: readonly string[] = APPEND_ONLY_TABLES): Promise<AppendOnlyGuardsReport> {
  return (await inspect(pool, tables)).report;
}

/** Como `checkAppendOnlyGuards`, pero dice si la consulta pudo hacerse (`verified`): con la base caída no se puede afirmar que falten, y el aviso del log no debe acusar a los guardianes. */
async function inspect(pool: Pick<Pool, 'query'>, tables: readonly string[]): Promise<{ report: AppendOnlyGuardsReport; verified: boolean }> {
  const expected = expectedGuards(tables);
  try {
    const { rows } = await pool.query<{ table_name: string; name: string; type: number }>(
      `SELECT c.relname AS table_name, t.tgname AS name, t.tgtype::int AS type
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND t.tgenabled IN ('O', 'A')
          AND p.proname = 'forbid_mutation'
          AND t.tgrelid IN (SELECT to_regclass(x)::oid FROM unnest($1::text[]) AS x WHERE to_regclass(x) IS NOT NULL)`,
      [[...tables]],
    );
    const present = new Set(rows.map((row) => `${row.table_name}.${row.name}.${Number(row.type)}`));
    const missing = expected.filter((guard) => !present.has(`${guard.table}.${guard.name}.${guard.type}`)).map((guard) => guard.name);
    return { report: { ok: missing.length === 0, missing }, verified: true };
  } catch {
    return { report: { ok: false, missing: expected.map((guard) => guard.name) }, verified: false };
  }
}

/**
 * El chequeo de `/health/ready` de un servicio: el informe, el aviso en el log cuando cambia y la decisión de si bloquea la disponibilidad.
 * Sandbox: el servicio sigue listo, pero `ok: false` se ve y se avisa (warn). Live: `ok: false` ⇒ no listo (el log sale como error).
 * El aviso sale una vez por cambio de estado (no en cada sondeo del orquestador) y solo nombra triggers: nunca datos.
 */
export class AppendOnlyGuardsProbe {
  private readonly logger = new Logger('AppendOnlyGuards');
  private lastSignature: string | undefined;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly payMode: 'sandbox' | 'live',
    private readonly tables: readonly string[] = APPEND_ONLY_TABLES,
  ) {}

  async report(): Promise<AppendOnlyGuardsReport> {
    const { report, verified } = await inspect(this.pool, this.tables);
    if (!verified) return report; // base inaccesible: la readiness ya cae por la base; no se acusa a los guardianes ni se cambia el estado recordado
    const signature = report.missing.join(',');
    if (signature !== this.lastSignature) {
      const previous = this.lastSignature;
      this.lastSignature = signature;
      if (!report.ok) {
        const payload = { event: 'append_only_guards_missing', pay_mode: this.payMode, missing: report.missing };
        const message = `Faltan guardianes de solo-agregar en la base (${report.missing.length}): reaplicar el DDL del servicio (docs/runbooks/sandbox-a-produccion.md)`;
        if (this.payMode === 'live') this.logger.error(payload, message);
        else this.logger.warn(payload, message);
      } else if (previous !== undefined) {
        this.logger.log({ event: 'append_only_guards_restored' }, 'Los guardianes de solo-agregar están completos');
      }
    }
    return report;
  }

  /** Bajo `PAY_MODE=live`, un guardián ausente deja al servicio no listo. En sandbox nunca bloquea. */
  blocksReadiness(report: AppendOnlyGuardsReport): boolean {
    return this.payMode === 'live' && !report.ok;
  }
}
