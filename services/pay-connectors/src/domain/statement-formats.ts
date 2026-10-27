import { XMLBuilder } from 'fast-xml-parser';
import { fromMinor } from '@pay/money';
import type { StatementLine } from './connector';

/**
 * Salidas del extracto: `camt.053` (ISO 20022) y CSV.
 *
 * LÍMITE DECLARADO: la estructura de `camt.053.001.02` sigue el estándar de memoria y se verifica por buena formación y por
 * ida y vuelta; **no se validó contra el XSD oficial de ISO 20022** (no se pudo descargar desde el entorno de trabajo). Antes de
 * enviarla a un tercero hay que validarla contra el XSD. El formato en que entrega el extracto el Banco Mercantil es otra
 * pregunta abierta (Q-01, Q-11).
 */
export interface StatementMeta {
  readonly connector: string;
  readonly accountId: string;
  readonly from: Date;
  readonly to: Date;
  readonly generatedAt: Date;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function toCamt053(lines: readonly StatementLine[], meta: StatementMeta): string {
  const credits = lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amountMinor, 0n);
  const debits = lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amountMinor, 0n);
  const closing = credits - debits;
  const balance = (code: 'OPBD' | 'CLBD', amount: bigint, date: Date) => ({
    Tp: { CdOrPrtry: { Cd: code } },
    Amt: { '#text': fromMinor(amount < 0n ? -amount : amount), '@_Ccy': 'BOB' },
    CdtDbtInd: amount < 0n ? 'DBIT' : 'CRDT',
    Dt: { Dt: ymd(date) },
  });
  const document = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    Document: {
      '@_xmlns': 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02',
      BkToCstmrStmt: {
        GrpHdr: { MsgId: `STMT-${meta.connector}-${ymd(meta.from)}-${ymd(meta.to)}`, CreDtTm: meta.generatedAt.toISOString() },
        Stmt: {
          Id: `${meta.connector}-${ymd(meta.from)}`,
          CreDtTm: meta.generatedAt.toISOString(),
          FrToDt: { FrDtTm: meta.from.toISOString(), ToDtTm: meta.to.toISOString() },
          Acct: { Id: { Othr: { Id: meta.accountId } }, Ccy: 'BOB' },
          Bal: [balance('OPBD', 0n, meta.from), balance('CLBD', closing, meta.to)],
          Ntry: lines.map((l) => ({
            NtryRef: l.providerReference,
            Amt: { '#text': fromMinor(l.amountMinor), '@_Ccy': l.currency },
            CdtDbtInd: l.direction === 'credit' ? 'CRDT' : 'DBIT',
            Sts: 'BOOK',
            BookgDt: { Dt: (l.bookedAt ?? new Date(`${l.valueDate}T00:00:00Z`)).toISOString().slice(0, 10) },
            ValDt: { Dt: l.valueDate },
            AcctSvcrRef: l.providerReference,
            BkTxCd: { Prtry: { Cd: 'NTRF' } },
            NtryDtls: { TxDtls: { Refs: l.ourReference ? { EndToEndId: l.ourReference } : {}, ...(l.description ? { AddtlTxInf: l.description.slice(0, 140) } : {}) } },
          })),
        },
      },
    },
  };
  return new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true, processEntities: true }).build(document) as string;
}

export const CSV_COLUMNS = ['provider_reference', 'our_reference', 'charge_id', 'direction', 'amount_minor', 'currency', 'value_date', 'booked_at', 'description'] as const;

/** RFC 4180 + protección contra inyección de fórmulas: una celda que empieza con `= + - @` o tabulación se antepone con `'`. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(lines: ReadonlyArray<StatementLine & { chargeId?: string | null }>): string {
  const rows = lines.map((l) =>
    [l.providerReference, l.ourReference, l.chargeId ?? '', l.direction, l.amountMinor.toString(), l.currency, l.valueDate, l.bookedAt?.toISOString() ?? '', l.description ?? ''].map(csvCell).join(','),
  );
  return `${CSV_COLUMNS.join(',')}\r\n${rows.join('\r\n')}${rows.length > 0 ? '\r\n' : ''}`;
}
