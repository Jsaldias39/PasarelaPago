import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import type { PayMode } from './mode';
import { fieldError, exportQuery, parseOrThrow } from './schemas';
import { LEDGER_PORT, type LedgerPort, type LedgerStatementEntry } from './ports';

export interface ExportLine {
  readonly kind: 'charge' | 'refund' | 'monthly_fee' | 'provider_commission' | 'chargeback_debt';
  readonly reference: string;
  readonly gross_minor: number;
  readonly fee_minor: number;
  readonly net_minor: number;
}

export interface AccountingExport {
  readonly schema: 'alovida-pay.accounting-export/v1';
  readonly period_from: string;
  readonly period_to: string;
  readonly currency: 'BOB';
  readonly generated_at: string;
  readonly merchants: { merchant_id: string; lines: ExportLine[]; total_fee_minor: number }[];
  readonly totals: { gross_minor: number; fee_minor: number; net_minor: number };
  /** Cuadre contra el ledger: las comisiones exportadas contra el neto real de `platform:fees` en el periodo. */
  readonly ledger: { platform_fees_minor: number; unassigned_minor: number; difference_minor: number };
  readonly balanced: boolean;
}

const net = (entries: readonly LedgerStatementEntry[], side: 'credit' | 'debit'): number => entries.filter((e) => e.direction === side).reduce((s, e) => s + e.amount_minor, 0);

/**
 * Exportación (de UN modo) de asientos de un periodo cerrado para M16 (accounting) — P2.H2.M7, D-21 (una factura por periodo y comercio).
 *
 * Se arma SOLO con lo que el ledger y este servicio saben: por comercio, cada cobro (bruto = neto + comisión) y cada cobro de abono,
 * comisión programada o contracargo. «Cuadra» quiere decir: la suma de comisiones exportadas es igual al neto real de `platform:fees`
 * en el periodo y no queda ninguna comisión sin comercio. Si no cuadra, la exportación se devuelve igual con `balanced: false` y la
 * diferencia a la vista: no se maquilla.
 */
@Injectable()
export class AccountingExportService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
  ) {}

  async build(rawQuery: unknown, mode: PayMode): Promise<AccountingExport> {
    const q = parseOrThrow(exportQuery, rawQuery);
    const from = new Date(q.period_from);
    const to = new Date(q.period_to);
    if (from >= to) throw fieldError('period_to', 'must_be_after_period_from');
    if (to.getTime() > Date.now()) throw new ProblemError('invalid_state_transition', { detail: 'El periodo todavía no cerró' });
    const open = await this.pool.query(`SELECT 1 FROM settlement_batches WHERE mode = $3 AND release_before < $2 AND created_at >= $1 AND status <> 'completed' LIMIT 1`, [from, to, mode]);
    if (open.rowCount) throw new ProblemError('invalid_state_transition', { detail: 'Hay cortes del periodo sin completar' });

    const window = { from: from.toISOString(), to: to.toISOString() };
    const merchants = (await this.pool.query<{ merchant_id: string }>('SELECT merchant_id FROM settlement_merchants ORDER BY merchant_id')).rows.map((r) => r.merchant_id);
    const fees = await this.ledger.listStatement(mode, 'platform:fees', window);

    // Qué comercio es dueño de cada referencia: el que recibió el cobro en `pending` o el que pagó el abono/comisión/contracargo.
    const owner = new Map<string, string>();
    const perMerchant = new Map<string, ExportLine[]>();
    for (const merchantId of merchants) {
      const entries = await this.ledger.listStatement(mode, `merchant:${merchantId}:pending`, window);
      const lines: ExportLine[] = [];
      const byRef = new Map<string, { charge: number; refund: number }>();
      for (const e of entries) {
        if (e.code !== 'charge' && e.code !== 'refund') continue;
        const slot = byRef.get(e.business_ref) ?? { charge: 0, refund: 0 };
        if (e.code === 'charge') slot.charge += e.direction === 'credit' ? e.amount_minor : -e.amount_minor;
        else slot.refund += e.direction === 'debit' ? e.amount_minor : -e.amount_minor;
        byRef.set(e.business_ref, slot);
        owner.set(e.business_ref, merchantId);
      }
      for (const [ref, v] of byRef) {
        const fee = fees.filter((f) => f.business_ref === ref).reduce((s, f) => s + (f.direction === 'credit' ? f.amount_minor : -f.amount_minor), 0);
        if (v.charge !== 0 || fee !== 0) lines.push({ kind: 'charge', reference: ref, gross_minor: v.charge + fee, fee_minor: fee, net_minor: v.charge });
        if (v.refund !== 0) lines.push({ kind: 'refund', reference: ref, gross_minor: v.refund, fee_minor: 0, net_minor: v.refund });
      }
      perMerchant.set(merchantId, lines);
    }

    const collections = await this.pool.query<{ merchant_id: string; kind: ExportLine['kind']; ledger_ref: string; amount_minor: string }>(
      `SELECT c.merchant_id, c.kind, k.ledger_ref, k.amount_minor
         FROM settlement_charge_collections k JOIN settlement_charges c ON c.id = k.charge_id
        WHERE c.mode = $3 AND k.status = 'posted' AND k.created_at >= $1 AND k.created_at < $2 ORDER BY k.created_at, k.seq`,
      [from, to, mode],
    );
    for (const row of collections.rows) {
      const lines = perMerchant.get(row.merchant_id) ?? [];
      const amount = Number(row.amount_minor);
      // El abono y la comisión programada son ingreso de la plataforma; el contracargo no pasa por `platform:fees`.
      lines.push({ kind: row.kind, reference: row.ledger_ref, gross_minor: amount, fee_minor: row.kind === 'chargeback_debt' ? 0 : amount, net_minor: row.kind === 'chargeback_debt' ? amount : 0 });
      owner.set(row.ledger_ref, row.merchant_id);
      perMerchant.set(row.merchant_id, lines);
    }

    const exported = [...perMerchant.entries()]
      .filter(([, lines]) => lines.length > 0)
      .map(([merchant_id, lines]) => ({ merchant_id, lines, total_fee_minor: lines.reduce((s, l) => s + l.fee_minor, 0) }));
    const feeTotal = exported.reduce((s, m) => s + m.total_fee_minor, 0);
    const ledgerFees = net(fees, 'credit') - net(fees, 'debit');
    const unassigned = fees.filter((f) => !owner.has(f.business_ref)).reduce((s, f) => s + (f.direction === 'credit' ? f.amount_minor : -f.amount_minor), 0);
    const all = exported.flatMap((m) => m.lines);
    return {
      schema: 'alovida-pay.accounting-export/v1',
      period_from: window.from,
      period_to: window.to,
      currency: 'BOB',
      generated_at: new Date().toISOString(),
      merchants: exported,
      totals: { gross_minor: all.reduce((s, l) => s + l.gross_minor, 0), fee_minor: feeTotal, net_minor: all.reduce((s, l) => s + l.net_minor, 0) },
      ledger: { platform_fees_minor: ledgerFees, unassigned_minor: unassigned, difference_minor: ledgerFees - feeTotal },
      balanced: unassigned === 0 && ledgerFees === feeTotal,
    };
  }
}

/** CSV para M16: una fila por línea. `reference` es opaca; nunca lleva datos personales. */
export function exportToCsv(doc: AccountingExport): string {
  const rows = ['merchant_id,kind,reference,gross_minor,fee_minor,net_minor,currency'];
  for (const m of doc.merchants) for (const l of m.lines) rows.push([m.merchant_id, l.kind, l.reference, l.gross_minor, l.fee_minor, l.net_minor, doc.currency].join(','));
  return `${rows.join('\n')}\n`;
}
