import { StatementMalformedError } from '../src/settlement/errors';
import type { StatementLine } from '../src/settlement/ports';
import { parseCamt053, parseCsvStatement, parseJsonStatement, parseStatement } from '../src/settlement/statement-parsers';

const LINE: StatementLine = { provider_reference: 'BNK001', our_reference: 'pi_abcdefghijkl:capture', direction: 'credit', amount_minor: 10000, value_date: '2026-10-20', booked_at: '2026-10-20T14:30:00.000Z' };

const csv = (rows: string[], header = 'provider_reference,our_reference,direction,amount_minor,currency,value_date,booked_at,description') => `${header}\n${rows.join('\n')}\n`;
const CSV_ROW = 'BNK001,pi_abcdefghijkl:capture,credit,10000,BOB,2026-10-20,2026-10-20T14:30:00.000Z,Juan Pérez CI 1234567';

const entry = (over: { ccy?: string; amt?: string; sign?: string; bookedDt?: string; bookedTm?: string | null; valDt?: string; ref?: string | null; e2e?: string | null; details?: string } = {}) => {
  const ref = over.ref === null ? '' : `<AcctSvcrRef>${over.ref ?? 'BNK001'}</AcctSvcrRef>`;
  const e2e = over.e2e === null ? '' : `<Refs><EndToEndId>${over.e2e ?? 'pi_abcdefghijkl:capture'}</EndToEndId></Refs>`;
  return `<Ntry><NtryRef>N1</NtryRef><Amt Ccy="${over.ccy ?? 'BOB'}">${over.amt ?? '100.00'}</Amt><CdtDbtInd>${over.sign ?? 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt>${over.bookedTm !== undefined && over.bookedTm !== null ? `<DtTm>${over.bookedTm}</DtTm>` : `<Dt>${over.bookedDt ?? '2026-10-20'}</Dt>`}</BookgDt><ValDt><Dt>${over.valDt ?? '2026-10-20'}</Dt></ValDt>${ref}
    <NtryDtls>${over.details ?? `<TxDtls>${e2e}</TxDtls>`}</NtryDtls></Ntry>`;
};
const camt = (entries: string[], wrapper = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>M1</MsgId></GrpHdr><Stmt><Id>S1</Id>${inner}</Stmt></BkToCstmrStmt></Document>`) => wrapper(entries.join(''));

const malformed = (fn: () => unknown, reason?: RegExp) => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StatementMalformedError);
  if (reason) expect((thrown as Error).message).toMatch(reason);
};

describe('los tres formatos dan la misma línea normalizada', () => {
  it('JSON, CSV y camt.053 ⇒ idéntico (y la glosa del banco con datos personales se descarta)', () => {
    const fromJson = parseJsonStatement([{ ...LINE, currency: 'BOB', description: 'Juan Pérez CI 1234567', charge_id: 'ch_abcdefghijkl' }]);
    const fromCsv = parseCsvStatement(csv([CSV_ROW]));
    const fromXml = parseCamt053(camt([entry({ bookedTm: '2026-10-20T14:30:00Z' })]));
    expect(fromJson).toEqual([LINE]);
    expect(fromCsv).toEqual([LINE]);
    expect(fromXml).toEqual([LINE]);
    expect(JSON.stringify([fromJson, fromCsv, fromXml])).not.toContain('Pérez');
  });

  it('límite: importe de 1 centavo y de 0, sentido de débito, sin nuestra referencia, camt con NOTPROVIDED', () => {
    expect(parseJsonStatement([{ ...LINE, amount_minor: 1 }])[0].amount_minor).toBe(1);
    expect(parseJsonStatement([{ ...LINE, amount_minor: 0 }])[0].amount_minor).toBe(0);
    expect(parseCsvStatement(csv(['B2,,debit,5,BOB,2026-10-20,,'])).at(0)).toMatchObject({ our_reference: null, direction: 'debit', amount_minor: 5, booked_at: null });
    expect(parseCamt053(camt([entry({ e2e: 'NOTPROVIDED', sign: 'DBIT', amt: '0.01' })]))[0]).toMatchObject({ our_reference: null, direction: 'debit', amount_minor: 1, booked_at: null });
    expect(parseCamt053(camt([entry({ amt: '1234567.89' })]))[0].amount_minor).toBe(123456789);
    expect(parseCamt053(camt([entry({ amt: '5' })]))[0].amount_minor).toBe(500);
  });

  it('un extracto vacío es válido y no tiene líneas', () => {
    expect(parseJsonStatement([])).toEqual([]);
    expect(parseCsvStatement(csv([]))).toEqual([]);
    expect(parseCamt053(camt([]))).toEqual([]);
  });

  it('camt.053: sin AcctSvcrRef cae a NtryRef', () => {
    expect(parseCamt053(camt([entry({ ref: null })]))[0].provider_reference).toBe('N1');
  });

  it('un BOM al inicio del CSV no rompe la cabecera', () => {
    expect(parseCsvStatement(`${String.fromCharCode(0xfeff)}${csv([CSV_ROW])}`)).toEqual([LINE]);
  });
});

describe('fechas inválidas: extracto ilegible, nunca una excepción del runtime', () => {
  it.each([
    ['vacía', ''],
    ['con letras', 'ayer'],
    ['mes 13', '2026-13-01'],
    ['día 32', '2026-10-32'],
    ['30 de febrero', '2026-02-30'],
    ['año 0000', '0000-01-01'],
    ['año absurdo 9999', '9999-12-31'],
    ['año anterior al rango', '1969-12-31'],
    ['con formato regional', '20/10/2026'],
  ])('value_date %s (JSON y CSV)', (_n, value) => {
    malformed(() => parseJsonStatement([{ ...LINE, value_date: value }]));
    malformed(() => parseCsvStatement(csv([`B1,x,credit,10,BOB,${value},,`])));
  });

  it.each([
    ['basura', 'no-es-fecha'],
    ['vacía (no es null)', ''],
    ['30 de febrero', '2026-02-30T10:00:00.000Z'],
    ['año absurdo', '+275760-09-13T00:00:00.000Z'],
    ['año 9999', '9999-12-31T23:59:59.000Z'],
    ['sin zona horaria', '2026-10-20T14:30:00'],
  ])('booked_at %s (JSON)', (_n, value) => {
    malformed(() => parseJsonStatement([{ ...LINE, booked_at: value }]));
  });

  it.each([
    ['basura', 'garbage'],
    ['vacía', ''],
    ['mes 13', '2026-13-20T10:00:00Z'],
    ['año 9999', '9999-12-31T00:00:00Z'],
    ['año 0001', '0001-01-01T00:00:00Z'],
  ])('camt.053: BookgDt/DtTm %s ⇒ extracto ilegible, sin RangeError', (_n, value) => {
    malformed(() => parseCamt053(camt([entry({ bookedTm: value })])));
    malformed(() => parseStatement({ format: 'camt053', text: camt([entry({ bookedTm: value })]) }));
  });

  it('camt.053: ValDt inexistente o absurda', () => {
    malformed(() => parseCamt053(camt([entry({ valDt: '2026-02-30' })])));
    malformed(() => parseCamt053(camt([entry({ valDt: '9999-01-01' })])));
    malformed(() => parseCamt053(camt([entry({ valDt: '' })])));
  });

  it('la línea defectuosa se informa por número (1 es la primera)', () => {
    let error: StatementMalformedError | undefined;
    try {
      parseJsonStatement([LINE, { ...LINE, provider_reference: 'B2' }, { ...LINE, provider_reference: 'B3', value_date: 'x' }]);
    } catch (e) {
      error = e as StatementMalformedError;
    }
    expect(error?.line).toBe(3);
  });
});

describe('formas inválidas', () => {
  it.each([
    ['importe negativo', { ...LINE, amount_minor: -1 }],
    ['importe con decimales', { ...LINE, amount_minor: 10.5 }],
    ['importe como texto', { ...LINE, amount_minor: '100' }],
    ['importe fuera del rango seguro', { ...LINE, amount_minor: Number.MAX_SAFE_INTEGER + 2 }],
    ['sentido desconocido', { ...LINE, direction: 'sideways' }],
    ['moneda distinta de BOB', { ...LINE, currency: 'USD' }],
    ['campo no declarado', { ...LINE, saldo: 5 }],
    ['sin referencia del proveedor', { ...LINE, provider_reference: '' }],
    ['referencia enorme', { ...LINE, provider_reference: 'x'.repeat(201) }],
    ['la línea es null', null],
    ['la línea es un número', 7],
  ])('JSON: %s', (_n, line) => malformed(() => parseJsonStatement([line])));

  it('CSV: comillas sin cerrar, columnas de más o de menos, cabecera incompleta, importes mal escritos, moneda', () => {
    malformed(() => parseCsvStatement(csv(['B1,"pi_abc,credit,10,BOB,2026-10-20,,'])));
    malformed(() => parseCsvStatement(csv(['B1,pi_abc,credit,10,BOB,2026-10-20,,,extra,mas'])));
    malformed(() => parseCsvStatement(csv(['B1,pi_abc,credit,10'])));
    malformed(() => parseCsvStatement(csv(['B1,pi_abc,credit,10,BOB,2026-10-20,,'], 'provider_reference,direction,amount_minor')));
    for (const amount of ['12.5', '1e3', '-5', '', 'abc', '99999999999999999']) malformed(() => parseCsvStatement(csv([`B1,pi_abc,credit,${amount},BOB,2026-10-20,,`])));
    malformed(() => parseCsvStatement(csv(['B1,pi_abc,credit,10,USD,2026-10-20,,'])));
    malformed(() => parseCsvStatement(csv(['B1,pi_abc,sideways,10,BOB,2026-10-20,,'])));
  });

  const full = camt([entry()]);
  it.each<[string, string, RegExp?]>([
    ['truncado a la mitad', full.slice(0, Math.floor(full.length / 2))],
    ['truncado sin las últimas etiquetas', full.slice(0, full.length - 10)],
    ['vacío', ''],
    ['no es XML', 'esto no es xml'],
    ['otra raíz', '<Document><Otra/></Document>', /camt\.053/],
    ['DOCTYPE con entidad externa (XXE)', `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>${full}`, /DOCTYPE/],
    ['moneda distinta', camt([entry({ ccy: 'USD' })]), /moneda/],
    ['importe en notación científica', camt([entry({ amt: '1e3' })])],
    ['importe negativo', camt([entry({ amt: '-5' })])],
    ['importe con tres decimales', camt([entry({ amt: '1.234' })])],
    ['importe vacío', camt([entry({ amt: '' })])],
    ['importe con letras', camt([entry({ amt: 'abc' })])],
    ['importe con coma decimal', camt([entry({ amt: '100,00' })])],
    ['sentido inválido', camt([entry({ sign: 'XXXX' })])],
    ['sin AcctSvcrRef ni NtryRef', camt([entry({ ref: null })]).replace('<NtryRef>N1</NtryRef>', ''), /AcctSvcrRef/],
    ['entrada agrupada', camt([entry({ details: '<TxDtls><Refs><EndToEndId>a</EndToEndId></Refs></TxDtls><TxDtls><Refs><EndToEndId>b</EndToEndId></Refs></TxDtls>' })]), /agrupada/],
  ])('camt.053 %s', (_n, text, ...rest) => malformed(() => parseCamt053(text), rest[0]));

  it('un XML que parsea pero con otra forma jamás deja pasar un error del runtime: todo es StatementMalformedError', () => {
    for (const text of ['<Document><BkToCstmrStmt><Stmt><Ntry>texto</Ntry></Stmt></BkToCstmrStmt></Document>', '<Document><BkToCstmrStmt><Stmt><Ntry><Amt/></Ntry></Stmt></BkToCstmrStmt></Document>', '<Document><BkToCstmrStmt/></Document>']) {
      malformed(() => parseStatement({ format: 'camt053', text }));
    }
  });
});

describe('parseStatement: cualquier error que no sea de dominio se convierte en StatementMalformedError', () => {
  it('un getter que lanza RangeError, un objeto sin prototipo y un BigInt no escapan como excepciones del runtime', () => {
    const hostile = {
      get provider_reference(): string {
        throw new RangeError('Invalid time value');
      },
    };
    malformed(() => parseStatement({ format: 'json', lines: [hostile as unknown as StatementLine] }));
    malformed(() => parseStatement({ format: 'json', lines: [Object.create(null) as StatementLine] }));
    malformed(() => parseStatement({ format: 'json', lines: [{ ...LINE, amount_minor: 10n as unknown as number }] }));
  });

  it('JSON entregado como texto: ilegible, sin lista, o con basura', () => {
    malformed(() => parseStatement({ format: 'json', text: '{"data":' }));
    malformed(() => parseStatement({ format: 'json', text: '{"otra":[]}' }));
    malformed(() => parseStatement({ format: 'json', text: '' }));
    malformed(() => parseStatement({ format: 'json' }));
    expect(parseStatement({ format: 'json', text: JSON.stringify({ data: [LINE] }) })).toEqual([LINE]);
  });

  it('csv/camt sin texto', () => {
    malformed(() => parseStatement({ format: 'csv' }));
    malformed(() => parseStatement({ format: 'camt053' }));
  });
});

describe('payment_intent_id (clave de cruce, ola 2): opcional en JSON y CSV; inexistente en camt.053', () => {
  const PI = 'pi_abcdefghijkl';

  it('JSON: lo conserva cuando viene, y ausente o null no cambian nada', () => {
    const [withIntent] = parseJsonStatement([{ ...LINE, our_reference: 'ch_abcdefghijkl', payment_intent_id: PI, charge_id: 'ch_abcdefghijkl', currency: 'BOB' }]);
    expect(withIntent).toMatchObject({ our_reference: 'ch_abcdefghijkl', payment_intent_id: PI });
    expect(parseJsonStatement([{ ...LINE, payment_intent_id: null }])[0].payment_intent_id).toBeNull();
    expect(parseJsonStatement([LINE])[0].payment_intent_id).toBeUndefined();
  });

  it.each([
    ['un id de cobro del conector', 'ch_abcdefghijkl'],
    ['mayúsculas', 'PI_ABCDEFGHIJKL'],
    ['demasiado corto', 'pi_abc'],
    ['con la operación pegada', 'pi_abcdefghijkl:capture'],
    ['vacío', ''],
    ['un número', 12],
  ])('JSON con payment_intent_id inválido (%s) ⇒ extracto ilegible; no se corrige ni se ignora', (_n, value) => {
    malformed(() => parseJsonStatement([{ ...LINE, payment_intent_id: value }]), /payment_intent_id/);
  });

  it('CSV: la columna es OPCIONAL; con ella se conserva (vacío ⇒ null) y mal escrita ⇒ extracto ilegible', () => {
    const withColumn = csv(['BNK001,ch_abcdefghijkl,pi_abcdefghijkl,credit,10000,BOB,2026-10-20,2026-10-20T14:30:00.000Z,', 'BNK002,ch_zyxwvutsrqpo,,credit,500,BOB,2026-10-20,2026-10-20T14:30:00.000Z,'], 'provider_reference,our_reference,payment_intent_id,direction,amount_minor,currency,value_date,booked_at,description');
    const lines = parseCsvStatement(withColumn);
    expect(lines.map((l) => l.payment_intent_id)).toEqual([PI, null]);
    expect(parseCsvStatement(csv([CSV_ROW]))[0].payment_intent_id).toBeUndefined();
    malformed(() => parseCsvStatement(csv(['BNK001,ch_abcdefghijkl,ch_abcdefghijkl,credit,10000,BOB,2026-10-20,2026-10-20T14:30:00.000Z,'], 'provider_reference,our_reference,payment_intent_id,direction,amount_minor,currency,value_date,booked_at,description')), /payment_intent_id/);
  });

  it('camt.053 no tiene dónde llevarlo: la línea sale sin payment_intent_id y se cruza por el respaldo (`EndToEndId`)', () => {
    const [line] = parseCamt053(camt([entry()]));
    expect(line.payment_intent_id).toBeUndefined();
    expect(line.our_reference).toBe('pi_abcdefghijkl:capture');
  });
});

describe('merchant_id (verificación del comercio, ola 2, 4c): opcional en JSON y CSV; inexistente en camt.053', () => {
  const MC = 'mc_abcdefghijk';
  const HEADER = 'provider_reference,our_reference,payment_intent_id,merchant_id,direction,amount_minor,currency,value_date,booked_at,description';

  it('JSON: lo conserva cuando viene, y ausente o null no cambian nada', () => {
    expect(parseJsonStatement([{ ...LINE, merchant_id: MC }])[0].merchant_id).toBe(MC);
    expect(parseJsonStatement([{ ...LINE, merchant_id: null }])[0].merchant_id).toBeNull();
    expect(parseJsonStatement([LINE])[0].merchant_id).toBeUndefined();
  });

  it.each([
    ['un id de otro tipo', 'pi_abcdefghijkl'],
    ['mayúsculas', 'MC_ABCDEFGHIJK'],
    ['demasiado corto', 'mc_abc'],
    ['vacío', ''],
    ['un número', 7],
  ])('JSON con merchant_id inválido (%s) ⇒ extracto ilegible; no se corrige ni se ignora', (_n, value) => {
    malformed(() => parseJsonStatement([{ ...LINE, merchant_id: value }]), /merchant_id/);
  });

  it('CSV: la columna es OPCIONAL; con ella se conserva (vacío ⇒ null) y mal escrita ⇒ extracto ilegible', () => {
    const lines = parseCsvStatement(csv([`BNK001,ch_abcdefghijkl,pi_abcdefghijkl,${MC},credit,10000,BOB,2026-10-20,2026-10-20T14:30:00.000Z,`, 'BNK002,ch_zyxwvutsrqpo,,,credit,500,BOB,2026-10-20,2026-10-20T14:30:00.000Z,'], HEADER));
    expect(lines.map((l) => l.merchant_id)).toEqual([MC, null]);
    expect(parseCsvStatement(csv([CSV_ROW]))[0].merchant_id).toBeUndefined();
    malformed(() => parseCsvStatement(csv(['BNK001,ch_abcdefghijkl,pi_abcdefghijkl,mc_x,credit,10000,BOB,2026-10-20,2026-10-20T14:30:00.000Z,'], HEADER)), /merchant_id/);
  });

  it('camt.053 no tiene dónde llevarlo: la línea sale sin merchant_id', () => {
    expect(parseCamt053(camt([entry()]))[0].merchant_id).toBeUndefined();
  });
});
