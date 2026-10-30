import type { StatementEntry } from './bank.service';

/** Cuenta SINTÉTICA de sandbox que figura en el extracto (rótulo SANDBOX: ninguna parece real; T-03). */
export const SANDBOX_ACCOUNT = { holder: 'ALOVIDA PAY (SANDBOX)', id: 'SANDBOX-0000-0001' } as const;

/** Decimal con dos cifras a partir de unidades menores, SIN pasar por punto flotante. */
export function decimal(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Neutraliza la inyección de fórmulas al abrir el CSV en una hoja de cálculo. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(entries: readonly StatementEntry[]): string {
  const header = 'bank_reference,our_reference,direction,amount,currency,value_date,booked_at,description';
  const rows = entries.map((e) => [e.bankReference, e.ourReference ?? '', e.direction, decimal(e.amountMinor), 'BOB', e.valueDate, e.bookedAt.toISOString(), e.description ?? ''].map(csvCell).join(','));
  return `${[header, ...rows].join('\r\n')}\r\n`;
}

/**
 * Extracto con la estructura PÚBLICA de ISO 20022 `camt.053.001.02` (BkToCstmrStmt). Solo la forma estándar: el perfil real del banco
 * (campos propios, huso, corte diario) no se conoce (lista de pedido, punto 10 de docs/spikes/banco-mercantil.md) y no se inventa.
 */
export function toCamt053(entries: readonly StatementEntry[], range: { from: Date; to: Date }, now: Date): string {
  const msgId = `SANDBOX-${now.toISOString().replace(/[-:.TZ]/g, '')}`;
  const ntries = entries
    .map(
      (e) => `      <Ntry>
        <Amt Ccy="BOB">${decimal(e.amountMinor)}</Amt>
        <CdtDbtInd>${e.direction === 'credit' ? 'CRDT' : 'DBIT'}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><DtTm>${e.bookedAt.toISOString()}</DtTm></BookgDt>
        <ValDt><Dt>${e.valueDate}</Dt></ValDt>
        <AcctSvcrRef>${xml(e.bankReference)}</AcctSvcrRef>
        <NtryDtls><TxDtls>${e.ourReference ? `<Refs><EndToEndId>${xml(e.ourReference)}</EndToEndId></Refs>` : ''}${e.description ? `<RmtInf><Ustrd>${xml(e.description)}</Ustrd></RmtInf>` : ''}</TxDtls></NtryDtls>
      </Ntry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${now.toISOString()}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${msgId}-1</Id>
      <CreDtTm>${now.toISOString()}</CreDtTm>
      <FrToDt><FrDtTm>${range.from.toISOString()}</FrDtTm><ToDtTm>${range.to.toISOString()}</ToDtTm></FrToDt>
      <Acct><Id><Othr><Id>${SANDBOX_ACCOUNT.id}</Id></Othr></Id><Ccy>BOB</Ccy><Ownr><Nm>${xml(SANDBOX_ACCOUNT.holder)}</Nm></Ownr></Acct>
${ntries}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}
