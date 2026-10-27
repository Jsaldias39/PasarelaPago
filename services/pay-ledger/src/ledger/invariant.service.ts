import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { TB_ENGINE, TigerBeetleEngine } from './tb-engine';
import { accountTbId } from './ids';

export interface InvariantReport {
  readonly ok: boolean;
  readonly accounts: number;
  readonly totalDebitsPosted: string;
  readonly totalCreditsPosted: string;
  readonly totalDebitsPending: string;
  readonly totalCreditsPending: string;
  /** Cuentas cuyo acumulado en TigerBeetle no coincide con la suma de sus líneas de extracto en Postgres. */
  readonly mismatches: readonly { account: string; field: 'debits_posted' | 'credits_posted'; tigerbeetle: string; postgres: string }[];
  readonly checkedAt: string;
}

/**
 * Invariante global (REQ-P2-4): la suma de todos los débitos es igual a la suma de todos los créditos, y lo que dice TigerBeetle de
 * cada cuenta coincide con el extracto que guardamos en Postgres. La primera mitad la garantiza TigerBeetle por construcción; la
 * segunda detecta que los metadatos se hayan despegado del dinero (una caída entre los dos, un registro perdido).
 * Un incumplimiento se registra como error (sin datos personales: solo nombres de cuenta lógica e importes) y queda en `last`.
 */
@Injectable()
export class InvariantService {
  private readonly logger = new Logger(InvariantService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> | undefined;
  last: InvariantReport | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
  ) {}

  async check(): Promise<InvariantReport> {
    const known = await this.pool.query<{ account: string; tb_id: string }>('SELECT account, tb_id FROM ledger_accounts ORDER BY account');
    const sums = await this.pool.query<{ account: string; direction: 'debit' | 'credit'; total: string }>(
      'SELECT account, direction, SUM(amount_minor)::text AS total FROM ledger_statement_lines GROUP BY account, direction',
    );
    const pg = new Map(sums.rows.map((r) => [`${r.account}|${r.direction}`, BigInt(r.total)]));

    let debitsPosted = 0n;
    let creditsPosted = 0n;
    let debitsPending = 0n;
    let creditsPending = 0n;
    const mismatches: InvariantReport['mismatches'][number][] = [];
    for (let i = 0; i < known.rows.length; i += 1000) {
      const batch = known.rows.slice(i, i + 1000);
      const found = new Map((await this.tb.lookupAccounts(batch.map((r) => accountTbId(r.account)))).map((a) => [a.id, a]));
      for (const row of batch) {
        const account = found.get(accountTbId(row.account));
        if (!account) {
          mismatches.push({ account: row.account, field: 'debits_posted', tigerbeetle: 'ausente', postgres: String(pg.get(`${row.account}|debit`) ?? 0n) });
          continue;
        }
        debitsPosted += account.debits_posted;
        creditsPosted += account.credits_posted;
        debitsPending += account.debits_pending;
        creditsPending += account.credits_pending;
        const expectedDebits = pg.get(`${row.account}|debit`) ?? 0n;
        const expectedCredits = pg.get(`${row.account}|credit`) ?? 0n;
        if (account.debits_posted !== expectedDebits) mismatches.push({ account: row.account, field: 'debits_posted', tigerbeetle: String(account.debits_posted), postgres: String(expectedDebits) });
        if (account.credits_posted !== expectedCredits) mismatches.push({ account: row.account, field: 'credits_posted', tigerbeetle: String(account.credits_posted), postgres: String(expectedCredits) });
      }
    }

    const report: InvariantReport = {
      ok: debitsPosted === creditsPosted && debitsPending === creditsPending && mismatches.length === 0,
      accounts: known.rows.length,
      totalDebitsPosted: String(debitsPosted),
      totalCreditsPosted: String(creditsPosted),
      totalDebitsPending: String(debitsPending),
      totalCreditsPending: String(creditsPending),
      mismatches,
      checkedAt: new Date().toISOString(),
    };
    this.last = report;
    if (!report.ok) this.logger.error({ mismatches: report.mismatches.slice(0, 10), report: { ...report, mismatches: undefined } }, 'INVARIANTE DEL LEDGER ROTO');
    return report;
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return; // una verificación lenta no se pisa con la siguiente
      const run = this.check()
        .catch((error: Error) => this.logger.error({ err: error.name }, 'No se pudo verificar el invariante'))
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
        });
      this.inFlight = run;
    }, intervalMs);
    this.timer.unref();
  }

  /** Detiene el job y espera la verificación en curso, para cerrar el pool sin cortarla a la mitad. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
