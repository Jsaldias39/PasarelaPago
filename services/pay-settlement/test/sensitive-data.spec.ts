import request from 'supertest';
import { newCloudEvent } from '@pay/outbox';
import { type SettlementTestContext, createSettlementContext, key, merchantId } from './helpers/app';
import { CANARY, captureOutput, dumpSchema, findLeaks, panLikeValues, type Leak } from './helpers/sensitive';

/**
 * Gate «Datos sensibles» (PLAN-MAESTRO §7; reglas 90.2.1 y 96.8.2). pay-settlement recibe extractos del banco (`camt.053`/CSV) que, según
 * `docs/cumplimiento/pci-alcance.md` §3 y pregunta B, podrían traer PAN enmascarado o completo, nombres y documentos del pagador en la glosa: es
 * su mayor superficie. Se mete el canario en cada campo de texto libre de los extractos, en las peticiones y en los eventos de entrada, y se
 * busca TODO lo que el servicio produjo: logs, respuestas, eventos del outbox y filas de la base. El script `scripts/check-sensitive-data.sh` corre esto.
 */
let ctx: SettlementTestContext;
afterEach(async () => ctx?.close());

const AT = '2026-10-21T14:30:00.000Z';
const FROM = '2026-10-19T04:00:00.000Z';
const TO = '2026-10-26T04:00:00.000Z';
const POISON = { card_number: CANARY.pan, pan: CANARY.panSpaced, cvv: CANARY.cvv, holder_name: CANARY.name, document: CANARY.document, full_name: CANARY.name };
const GLOSA = `PAGO TARJETA ${CANARY.pan} ${CANARY.cvv} TITULAR ${CANARY.name} CI ${CANARY.document}`;

const csv = (rows: string[]) => `provider_reference,our_reference,direction,amount_minor,currency,value_date,booked_at,description\n${rows.join('\n')}\n`;
const camt = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>M1</MsgId></GrpHdr><Stmt><Id>S1</Id>${entries}</Stmt></BkToCstmrStmt></Document>`;
const camtEntry = (ref: string, e2e: string, amt: string) =>
  `<Ntry><NtryRef>${ref}</NtryRef><Amt Ccy="BOB">${amt}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>${AT}</DtTm></BookgDt><ValDt><Dt>2026-10-21</Dt></ValDt><AcctSvcrRef>${ref}</AcctSvcrRef>` +
  `<NtryDtls><TxDtls><Refs><EndToEndId>${e2e}</EndToEndId></Refs><RltdPties><Dbtr><Nm>${CANARY.name}</Nm><Id><PrvtId><Othr><Id>${CANARY.document}</Id></Othr></PrvtId></Id></Dbtr><DbtrAcct><Id><Othr><Id>${CANARY.pan}</Id></Othr></Id></DbtrAcct></RltdPties>` +
  `<RmtInf><Ustrd>${GLOSA}</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>${GLOSA}</AddtlNtryInf></Ntry>`;

describe('el detector funciona (control negativo)', () => {
  it('encuentra el canario en un extracto crudo y no se queja de un identificador normal', () => {
    expect(findLeaks('x', camt(camtEntry('B1', 'pi_abcdefghijkl:capture', '100.00'))).length).toBeGreaterThan(0);
    expect(findLeaks('x', csv([`B1,pi_abcdefghijkl:capture,credit,10000,BOB,2026-10-21,${AT},${GLOSA}`])).length).toBeGreaterThan(0);
    expect(panLikeValues('{"time":1793143929131,"id":"po_nll3pl3hrck7fxvjyxv3","amount_minor":10000}')).toEqual([]);
  });
});

describe('pay-settlement: lo que produce con datos sensibles en extractos, peticiones y eventos', () => {
  it('logs, respuestas, eventos del outbox y filas de la base quedan sin PAN, CVV, documento ni nombre', async () => {
    ctx = await createSettlementContext({ config: { statementFormats: { mock: 'csv', bank_transfer: 'camt053' } } });
    const responses: { where: string; text: string }[] = [];
    const record = (where: string, res: { status: number; body: unknown; text?: string }) => responses.push({ where: `${where} → ${res.status}`, text: res.text ?? JSON.stringify(res.body) ?? '' });
    const m = merchantId();

    const { output } = await captureOutput(async () => {
      // 1. Extractos con el canario en la glosa, el titular, el documento y la cuenta de origen: unos cruzan, otros abren excepciones (eventos).
      const matched = `pi_${Math.random().toString(36).slice(2, 12).padEnd(10, 'k')}x7q2:capture`;
      ctx.ledger.seedCharge({ merchant: m, net: 9700, fee: 300, at: new Date(AT), ref: matched });
      ctx.connectors.statements.set('mock', {
        format: 'csv',
        text: csv([`B1,${matched},credit,10000,BOB,2026-10-21,${AT},${GLOSA}`, `B2,pi_zzzzzzzzzzzz:capture,credit,555,BOB,2026-10-21,${AT},${GLOSA}`, `B3,,credit,777,BOB,2026-10-21,${AT},"${GLOSA}"`]),
      });
      ctx.connectors.statements.set('bank_transfer', { format: 'camt053', text: camt(camtEntry('C1', 'pi_yyyyyyyyyyyy:capture', '12.34') + camtEntry('C2', 'NOTPROVIDED', '1.00')) });
      for (const connector of ['mock', 'bank_transfer']) {
        const started = await ctx.as('pay-backoffice').post('/reconciliation_runs', { connector, period_from: FROM, period_to: TO }).set('idempotency-key', key());
        record(`POST /reconciliation_runs (${connector})`, started);
        await ctx.reconciliation.idle();
        record(`GET /reconciliation_runs/{id} (${connector})`, await ctx.as('pay-backoffice').get(`/reconciliation_runs/${started.body.id}`));
      }
      record('GET /reconciliation_exceptions', await ctx.as('pay-backoffice').get('/reconciliation_exceptions'));
      // un extracto ilegible con el canario: la corrida falla sin repetir el contenido
      ctx.connectors.statements.set('mock', { format: 'csv', text: `provider_reference,our_reference\n${GLOSA},${CANARY.pan}\n` });
      const bad = await ctx.as('pay-backoffice').post('/reconciliation_runs', { connector: 'mock', period_from: FROM, period_to: TO }).set('idempotency-key', key());
      await ctx.reconciliation.idle();
      record('GET /reconciliation_runs/{id} (extracto ilegible)', await ctx.as('pay-backoffice').get(`/reconciliation_runs/${bad.body.id}`));

      // 2. Peticiones con datos sensibles en lugares que el contrato no tiene o con formato inválido.
      record('POST /payouts con campos de tarjeta', await ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: 100, currency: 'BOB', rail: 'bank_transfer', reason: 'manual', ...POISON }).set('idempotency-key', key()));
      record('POST /payouts con el PAN como comercio', await ctx.as('pay-schedules').post('/payouts', { merchant_id: CANARY.pan, amount_minor: 100, currency: 'BOB', rail: 'bank_transfer', reason: CANARY.name }).set('idempotency-key', key()));
      record('POST /payouts con el nombre como riel', await ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: 100, currency: 'BOB', rail: CANARY.name, reason: 'manual' }).set('idempotency-key', key()));
      record('POST /reconciliation_runs con el PAN como conector', await ctx.as('pay-backoffice').post('/reconciliation_runs', { connector: CANARY.pan, period_from: FROM, period_to: TO }).set('idempotency-key', key()));
      record('POST /batches con campos de tarjeta', await ctx.as('pay-backoffice').post('/batches', { cutoff_date: '2026-10-19', ...POISON }).set('idempotency-key', key()));
      record('GET /payouts con X-Merchant-Id = PAN (pay-edge)', await ctx.as('pay-edge').get('/payouts').set('x-merchant-id', CANARY.pan));
      record('GET /payouts?merchant_id={documento}', await ctx.as('pay-schedules').get(`/payouts?merchant_id=${encodeURIComponent(CANARY.document)}`));
      record('sin identidad de servicio, con cuerpo sensible', await request(ctx.app.getHttpServer()).post('/payouts').send(POISON));

      // 3. Eventos de entrada: uno válido, otro con campos de tarjeta de más y otro con el dato como valor. Se descartan o se procesan, pero no se repiten.
      const base = { payment_intent_id: 'pi_abcdefghijkl', merchant_id: m, kind: 'status_conflict', current_status: 'failed', incoming_status: 'captured', mode: 'test', detected_at: '2026-10-27T15:00:00.000Z' };
      for (const data of [base, { ...base, ...POISON }, { ...base, kind: CANARY.name, current_status: CANARY.pan }, { ...base, payment_intent_id: CANARY.pan }]) {
        await ctx.consumers.handle(newCloudEvent({ source: '/pay-payments', type: 'payment_intent.contradiction_detected', subject: 'pi_abcdefghijkl', merchantId: m, data }));
      }
      await ctx.consumers.handle({ not: 'un sobre', ...POISON } as never);

      // 4. Error interno cuyo mensaje trae el dato: la respuesta no lo expone y el log solo lleva el nombre del error.
      const original = ctx.db.pool.query.bind(ctx.db.pool);
      let broken = false;
      (ctx.db.pool as { query: unknown }).query = (...args: unknown[]) => {
        if (!broken) {
          broken = true;
          return Promise.reject(new Error(`falló (tarjeta=${CANARY.pan}, ${CANARY.cvv}, titular=${CANARY.name}, doc=${CANARY.document})`));
        }
        return (original as (...a: unknown[]) => Promise<unknown>)(...args);
      };
      try {
        record('GET /payouts (error interno inyectado)', await ctx.as('pay-schedules').get('/payouts'));
      } finally {
        (ctx.db.pool as { query: unknown }).query = original;
      }
      expect(broken).toBe(true);
    });

    const dump = await dumpSchema(ctx.db.pool);
    const events = (await ctx.db.pool.query('SELECT envelope::text AS e FROM outbox_events')).rows.map((r) => r.e).join('\n');
    const leaks: Leak[] = [
      ...findLeaks('logs (stdout/stderr)', output),
      ...responses.flatMap((r) => findLeaks(`respuesta ${r.where}`, r.text)),
      ...findLeaks('eventos del outbox', events),
      ...findLeaks('filas de la base', dump.text),
    ];
    expect(leaks).toEqual([]);
    // la prueba mira de verdad
    expect(responses.filter((r) => /→ (4\d\d|5\d\d)$/.test(r.where)).length).toBeGreaterThanOrEqual(8);
    expect(responses.some((r) => r.where.includes('→ 500'))).toBe(true);
    expect(events.length).toBeGreaterThan(0); // hubo excepciones de conciliación con evento
    expect(dump.tables).toEqual(expect.arrayContaining(['settlement_reconciliation_runs', 'settlement_exceptions', 'settlement_statement_lines', 'outbox_events', 'inbox_events']));
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_exceptions')).rows[0].n).toBeGreaterThanOrEqual(4);
    expect(findLeaks('control', `${output}\n${CANARY.panDashed}`)).not.toEqual([]);
  });
});

describe('la Idempotency-Key con forma de PAN se guarda como su hash, nunca tal cual (@pay/idempotency, cerrado por P1)', () => {
  // La `Idempotency-Key` la elige quien llama y se guarda 24 h en `idempotency_keys.key`. Antes de que P1 lo cerrara, un PAN en esa cabecera quedaba en la base
  // (`it.failing` documentaba el hueco y avisó al cerrarse). Ahora la librería la guarda como `masked-<sha256>`: la petición SIGUE su curso (no se rechaza: un falso
  // positivo tiraría una petición legítima) y la misma clave sigue siendo idempotente.
  it('POST /payouts con un PAN como clave: ni el valor ni un fragmento llegan a la base ni a la respuesta, la clave queda enmascarada y reintentarla repite la respuesta', async () => {
    ctx = await createSettlementContext();
    const send = () => ctx.as('pay-schedules').post('/payouts', { merchant_id: merchantId(), amount_minor: 100, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', CANARY.pan);
    const first = await send();
    expect(findLeaks('respuesta', JSON.stringify(first.body))).toEqual([]);
    expect(findLeaks('filas de la base', (await dumpSchema(ctx.db.pool)).text)).toEqual([]);
    const keys = (await ctx.db.pool.query('SELECT key FROM idempotency_keys')).rows.map((r) => r.key as string);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => /^masked-[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(keys.filter((k) => k.includes('4111'))).toEqual([]); // la clave original no quedó en ninguna fila
  });
});
