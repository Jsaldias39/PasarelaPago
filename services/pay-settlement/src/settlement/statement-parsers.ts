import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { toMinor } from '@pay/money';
import { StatementMalformedError } from './errors';
import type { StatementDocument, StatementLine } from './ports';

/** Topes de cordura: un extracto más grande que esto no es un extracto, es un ataque o un error. */
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
export const MAX_STATEMENT_LINES = 200_000;

const lineSchema = z.strictObject({
  provider_reference: z.string().min(1).max(200),
  our_reference: z.string().min(1).max(200).nullable(),
  direction: z.enum(['credit', 'debit']),
  amount_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  value_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booked_at: z.iso.datetime().nullable(),
});

function validated(raw: unknown, index: number): StatementLine {
  const parsed = lineSchema.safeParse(raw);
  if (!parsed.success) throw new StatementMalformedError(`línea inválida (${parsed.error.issues[0]?.path.join('.') ?? 'forma'})`, index + 1);
  if (Number.isNaN(Date.parse(`${parsed.data.value_date}T00:00:00Z`))) throw new StatementMalformedError('fecha de valor inexistente', index + 1);
  return parsed.data;
}

/** Extracto JSON del conector (`StatementLine` de `internal-connectors-v1.yaml`). */
export function parseJsonStatement(lines: readonly unknown[]): StatementLine[] {
  if (lines.length > MAX_STATEMENT_LINES) throw new StatementMalformedError('demasiadas líneas');
  return lines.map((raw, i) => {
    const candidate = raw as Record<string, unknown>;
    if (candidate === null || typeof candidate !== 'object') throw new StatementMalformedError('línea inválida', i + 1);
    if (candidate.currency !== undefined && candidate.currency !== 'BOB') throw new StatementMalformedError('moneda distinta de BOB', i + 1);
    // `charge_id` y `description` son del contrato pero no entran a la conciliación; la glosa puede traer datos personales y se descarta.
    const { currency: _currency, charge_id: _chargeId, description: _description, ...rest } = candidate;
    return validated({ our_reference: null, booked_at: null, ...rest }, i);
  });
}

const CSV_COLUMNS = ['provider_reference', 'our_reference', 'direction', 'amount_minor', 'currency', 'value_date', 'booked_at'] as const;

/** CSV con las mismas columnas que `StatementLine` (`description` es opcional y se descarta). */
export function parseCsvStatement(text: string): StatementLine[] {
  if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) throw new StatementMalformedError('extracto demasiado grande');
  let records: Record<string, string>[];
  try {
    records = parseCsv(text.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: false, bom: true }) as Record<string, string>[];
  } catch (error) {
    const line = (error as { lines?: number }).lines;
    throw new StatementMalformedError('CSV ilegible', line);
  }
  if (records.length > MAX_STATEMENT_LINES) throw new StatementMalformedError('demasiadas líneas');
  if (records.length > 0) {
    const missing = CSV_COLUMNS.filter((c) => !(c in records[0]));
    if (missing.length > 0) throw new StatementMalformedError(`faltan columnas: ${missing.join(', ')}`, 1);
  }
  return records.map((r, i) => {
    if (r.currency !== 'BOB') throw new StatementMalformedError('moneda distinta de BOB', i + 2);
    if (!/^\d{1,15}$/.test(r.amount_minor)) throw new StatementMalformedError('importe inválido', i + 2);
    return validated(
      {
        provider_reference: r.provider_reference,
        our_reference: r.our_reference === '' ? null : r.our_reference,
        direction: r.direction,
        amount_minor: Number(r.amount_minor),
        value_date: r.value_date,
        booked_at: r.booked_at === '' ? null : r.booked_at,
      },
      i,
    );
  });
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false });

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { '#text'?: unknown })['#text'] === 'string' ? ((value as { '#text': string })['#text']) : undefined);

/**
 * Extracto ISO 20022 `camt.053` (BkToCstmrStmt). Una línea por `Ntry`:
 *  - `provider_reference` = `AcctSvcrRef` (o `NtryRef`); `our_reference` = `EndToEndId` del detalle (`NOTPROVIDED` ⇒ ninguna);
 *  - sentido = `CdtDbtInd` (CRDT ⇒ credit); importe = `Amt` (decimal, moneda BOB); fecha de valor = `ValDt`, asiento = `BookgDt`.
 * SUPUESTO declarado: el banco todavía no entregó su formato real (Q-11); esto sigue los campos estándar de la norma. Una entrada con
 * varios `TxDtls` (agrupada) NO se parte a mano: el extracto se rechaza antes que adivinar el reparto del importe.
 */
export function parseCamt053(document: string): StatementLine[] {
  if (Buffer.byteLength(document) > MAX_STATEMENT_BYTES) throw new StatementMalformedError('extracto demasiado grande');
  // Sin DTD: no hay entidades externas que resolver (XXE) ni expansión de entidades.
  if (/<!DOCTYPE|<!ENTITY/i.test(document)) throw new StatementMalformedError('DOCTYPE no permitido');
  let tree: Record<string, unknown>;
  try {
    tree = xml.parse(document) as Record<string, unknown>;
  } catch {
    throw new StatementMalformedError('XML ilegible');
  }
  const root = tree.Document as { BkToCstmrStmt?: { Stmt?: unknown } } | undefined;
  const statements = asArray(root?.BkToCstmrStmt?.Stmt) as { Ntry?: unknown }[];
  if (!root?.BkToCstmrStmt || statements.length === 0) throw new StatementMalformedError('no es un camt.053 (falta BkToCstmrStmt/Stmt)');

  const lines: StatementLine[] = [];
  for (const statement of statements) {
    for (const entry of asArray(statement.Ntry) as Record<string, unknown>[]) {
      const index = lines.length;
      const amount = entry.Amt as Record<string, unknown> | string | undefined;
      const currency = typeof amount === 'object' ? (amount['@_Ccy'] as string | undefined) : undefined;
      const value = text(amount);
      if (currency !== 'BOB') throw new StatementMalformedError('moneda distinta de BOB', index + 1);
      if (value === undefined || !/^\d+(\.\d{1,2})?$/.test(value)) throw new StatementMalformedError('importe inválido', index + 1);
      const sign = text(entry.CdtDbtInd);
      if (sign !== 'CRDT' && sign !== 'DBIT') throw new StatementMalformedError('CdtDbtInd inválido', index + 1);
      const details = asArray((entry.NtryDtls as { TxDtls?: unknown } | undefined)?.TxDtls) as { Refs?: { EndToEndId?: unknown } }[];
      if (details.length > 1) throw new StatementMalformedError('entrada agrupada (varios TxDtls) no soportada', index + 1);
      const providerReference = text(entry.AcctSvcrRef) ?? text(entry.NtryRef);
      if (!providerReference) throw new StatementMalformedError('falta AcctSvcrRef', index + 1);
      const endToEnd = text(details[0]?.Refs?.EndToEndId);
      const booked = text((entry.BookgDt as { Dt?: unknown; DtTm?: unknown } | undefined)?.DtTm);
      const valueDate = text((entry.ValDt as { Dt?: unknown } | undefined)?.Dt) ?? text((entry.BookgDt as { Dt?: unknown } | undefined)?.Dt);
      lines.push(
        validated(
          {
            provider_reference: providerReference,
            our_reference: endToEnd && endToEnd !== 'NOTPROVIDED' ? endToEnd : null,
            direction: sign === 'CRDT' ? 'credit' : 'debit',
            amount_minor: Number(toMinor(value)),
            value_date: valueDate,
            booked_at: booked ? new Date(booked).toISOString() : null,
          },
          index,
        ),
      );
      if (lines.length > MAX_STATEMENT_LINES) throw new StatementMalformedError('demasiadas líneas');
    }
  }
  return lines;
}

/** Normaliza lo que entregó el conector, sea cual sea su formato. */
export function parseStatement(document: StatementDocument): StatementLine[] {
  if (document.format === 'json') {
    if (document.lines) return parseJsonStatement(document.lines);
    let raw: unknown;
    try {
      raw = JSON.parse(document.text ?? '');
    } catch {
      throw new StatementMalformedError('JSON ilegible');
    }
    const data = (raw as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new StatementMalformedError('JSON sin lista de líneas');
    return parseJsonStatement(data);
  }
  if (document.text === undefined) throw new StatementMalformedError('extracto vacío');
  return document.format === 'csv' ? parseCsvStatement(document.text) : parseCamt053(document.text);
}
