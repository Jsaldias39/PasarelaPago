/**
 * «Ningún doble asiento»: se lee el extracto REAL de `merchant:<id>:pending` en pay-ledger (API interna, con identidad de servicio, solo lectura) y, para cada intento
 * `succeeded` de la prueba, se cuentan sus líneas de captura (`business_ref = <pi>:capture`, crédito sobre el pending del comercio): debe haber EXACTAMENTE una.
 */
export interface StatementLine {
  readonly business_ref: string;
  readonly direction: 'debit' | 'credit';
  readonly amount_minor: number;
}

export interface SucceededIntent {
  readonly id: string;
  readonly merchantId: string;
  readonly netMinor: number;
}

export interface LedgerCheck {
  readonly doubleEntries: number;
  readonly missingEntries: number;
  readonly amountMismatches: number;
  readonly checkedIntents: number;
  readonly linesRead: number;
}

/** Pura (probada sin red): cuenta duplicados, faltantes y diferencias de importe. */
export function checkCaptureLines(intents: readonly SucceededIntent[], linesByMerchant: ReadonlyMap<string, readonly StatementLine[]>): LedgerCheck {
  let doubleEntries = 0;
  let missingEntries = 0;
  let amountMismatches = 0;
  let linesRead = 0;
  const counts = new Map<string, { n: number; sum: number }>();
  for (const [merchant, lines] of linesByMerchant) {
    for (const line of lines) {
      linesRead += 1;
      if (line.direction !== 'credit' || !line.business_ref.endsWith(':capture')) continue;
      const key = `${merchant}|${line.business_ref}`;
      const current = counts.get(key) ?? { n: 0, sum: 0 };
      counts.set(key, { n: current.n + 1, sum: current.sum + line.amount_minor });
    }
  }
  for (const intent of intents) {
    const found = counts.get(`${intent.merchantId}|${intent.id}:capture`);
    if (!found) missingEntries += 1;
    else {
      if (found.n > 1) doubleEntries += found.n - 1;
      if (found.sum !== found.n * intent.netMinor) amountMismatches += 1;
    }
  }
  return { doubleEntries, missingEntries, amountMismatches, checkedIntents: intents.length, linesRead };
}

export interface LedgerReader {
  readonly baseUrl: string;
  /** Hora de inicio de la prueba (ISO): no se leen asientos anteriores. */
  readonly from: string;
}

/** Lee TODAS las páginas del extracto de un comercio desde `from` (paginación por cursor, más nuevo primero). */
export async function readPending(reader: LedgerReader, merchantId: string, fetchImpl: typeof fetch = fetch): Promise<StatementLine[]> {
  const lines: StatementLine[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100_000; page += 1) {
    const params = new URLSearchParams({ account: `merchant:${merchantId}:pending`, limit: '100', from: reader.from, ...(cursor ? { starting_after: cursor } : {}) });
    const res = await fetchImpl(`${reader.baseUrl}/statements?${params}`, { headers: { 'x-service-id': 'pay-payments', 'x-pay-mode': 'test', accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return lines; // la cuenta no existe todavía: sin asientos
    if (res.status !== 200) throw new Error(`GET /statements respondió ${res.status}`);
    const body = (await res.json()) as { data: StatementLine[]; has_more: boolean; next_cursor?: string | null };
    lines.push(...body.data);
    if (!body.has_more || !body.next_cursor) return lines;
    cursor = body.next_cursor;
  }
  throw new Error('extracto demasiado largo');
}
