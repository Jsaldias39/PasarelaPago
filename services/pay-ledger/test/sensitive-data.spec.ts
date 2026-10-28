import request from 'supertest';
import { type LedgerTestContext, businessRef, createLedgerContext, merchantId } from './helpers/app';
import { CANARY, captureOutput, dumpSchema, findLeaks, panLikeValues, type Leak } from './helpers/sensitive';

/**
 * Gate «Datos sensibles» (PLAN-MAESTRO §7; reglas 90.2.1 y 96.8.2): sin PAN, CVV, documento ni nombre en logs, eventos, errores ni base.
 * Se meten valores CANARIO por todas las puertas (campos que el contrato no tiene, ids malformados, rutas, errores internos con el dato dentro)
 * junto a operaciones legítimas, y se busca TODO lo que el servicio produjo. El script `scripts/check-sensitive-data.sh` corre esta prueba.
 */
let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const CLEARING = 'connector:mercantil_qr:clearing';
const leg = (debit_account: string, credit_account: string, amount_minor: number, code = 'charge') => ({ debit_account, credit_account, amount_minor, code });
const POISON = { card_number: CANARY.pan, pan: CANARY.panSpaced, cvv: CANARY.cvv, holder_name: CANARY.name, document: CANARY.document, full_name: CANARY.name };

describe('el detector funciona (control negativo)', () => {
  it('encuentra un canario, un PAN con espacios o guiones, un campo sensible y un nombre; no se queja de un instante en milisegundos ni de un id', () => {
    expect(findLeaks('x', `la tarjeta ${CANARY.pan}`)).not.toEqual([]);
    expect(panLikeValues(`a ${CANARY.panSpaced} b ${CANARY.panDashed}`)).toHaveLength(2);
    expect(findLeaks('x', '{"cvv":"123"}')).not.toEqual([]);
    expect(findLeaks('x', CANARY.name)).not.toEqual([]);
    expect(findLeaks('x', '{"time":1793143929131,"id":"hd_nll3pl3hrck7fxvjyxv3","amount_minor":10000,"tb":"340282366920938463463374607431768211455"}')).toEqual([]);
  });
});

describe('pay-ledger: lo que produce con datos sensibles en la entrada', () => {
  it('logs, respuestas, eventos del outbox y filas de la base quedan sin PAN, CVV, documento ni nombre', async () => {
    const m = merchantId();
    const responses: { where: string; text: string }[] = [];
    const record = (where: string, res: { status: number; body: unknown; text?: string }) => responses.push({ where: `${where} → ${res.status}`, text: res.text ?? JSON.stringify(res.body) ?? '' });

    const { output } = await captureOutput(async () => {
      // 1. Operaciones legítimas: generan filas, estado y eventos.
      const fundRef = businessRef();
      record('POST /transactions (legítima)', await ctx.as('pay-payments').post('/transactions', { business_ref: fundRef, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 5000)] }).set('idempotency-key', key()));
      record('POST /transactions (liberación)', await ctx.as('pay-settlement').post('/transactions', { business_ref: businessRef('release'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, `merchant:${m}:available`, 5000, 'release')] }).set('idempotency-key', key()));
      const hold = await ctx.as('pay-settlement').post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 2000, currency: 'BOB', expires_in_seconds: 60 }).set('idempotency-key', key());
      record('POST /holds (legítima)', hold);
      record('POST /holds/{id}/post', await ctx.as('pay-settlement').post(`/holds/${hold.body.id}/post`).set('idempotency-key', key()));
      // un rechazo de TigerBeetle (deja fila en ledger_rejections con su motivo)
      record('POST /transactions (saldo insuficiente)', await ctx.as('pay-settlement').post('/transactions', { business_ref: businessRef('payout'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:available`, 'payout:clearing', 999_999, 'payout')] }).set('idempotency-key', key()));

      // 2. Datos sensibles por todas las puertas.
      record('POST /transactions con campos de tarjeta', await ctx.as('pay-payments').post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 100)], ...POISON }).set('idempotency-key', key()));
      record('POST /transactions con el PAN como business_ref', await ctx.as('pay-payments').post('/transactions', { business_ref: CANARY.pan, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 100)] }).set('idempotency-key', key()));
      record('POST /transactions con el nombre como cuenta', await ctx.as('pay-payments').post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CANARY.name, `merchant:${m}:pending`, 100)] }).set('idempotency-key', key()));
      record('POST /transactions con el documento como código', await ctx.as('pay-payments').post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 100, CANARY.document)] }).set('idempotency-key', key()));
      record('POST /holds con campos de tarjeta', await ctx.as('pay-settlement').post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 1, currency: 'BOB', expires_in_seconds: 60, ...POISON }).set('idempotency-key', key()));
      record('GET /balances?account={PAN}', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(CANARY.pan)}`));
      record('GET /statements?account={documento}', await ctx.as('pay-settlement').get(`/statements?account=${encodeURIComponent(CANARY.document)}`));
      record('GET /balance con X-Merchant-Id = PAN', await ctx.as('pay-edge').get('/balance').set('x-merchant-id', CANARY.pan));
      record('sin identidad de servicio, con cuerpo sensible', await request(ctx.app.getHttpServer()).post('/transactions').send(POISON));

      // 3. Error interno cuyo mensaje trae el dato (un driver o una librería que lo copia): la respuesta no lo expone y el log solo lleva el NOMBRE del error.
      const original = ctx.db.pool.query.bind(ctx.db.pool);
      let broken = false;
      (ctx.db.pool as { query: unknown }).query = (...args: unknown[]) => {
        if (!broken) {
          broken = true;
          return Promise.reject(new Error(`duplicate key value violates unique constraint (card=${CANARY.pan}, cvv=${CANARY.cvv}, titular=${CANARY.name}, doc=${CANARY.document})`));
        }
        return (original as (...a: unknown[]) => Promise<unknown>)(...args);
      };
      try {
        for (let i = 0; i < 3 && broken === false; i += 1) record('GET /balances (error interno inyectado)', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`));
        if (broken) record('GET /balances (tras el error interno)', await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`));
      } finally {
        (ctx.db.pool as { query: unknown }).query = original;
      }
      expect(broken).toBe(true);
    });

    const dump = await dumpSchema(ctx.db.pool);
    const events = (await ctx.db.pool.query("SELECT envelope::text AS e FROM outbox_events")).rows.map((r) => r.e).join('\n');
    const leaks: Leak[] = [
      ...findLeaks('logs (stdout/stderr)', output),
      ...responses.flatMap((r) => findLeaks(`respuesta ${r.where}`, r.text)),
      ...findLeaks('eventos del outbox', events),
      ...findLeaks('filas de la base', dump.text),
    ];
    expect(leaks).toEqual([]);
    // la prueba mira de verdad: hay logs, respuestas de error, eventos y filas que revisar
    expect(output.length).toBeGreaterThan(0);
    expect(responses.filter((r) => /→ (4\d\d|5\d\d)$/.test(r.where)).length).toBeGreaterThanOrEqual(10);
    expect(responses.some((r) => r.where.includes('→ 500'))).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(dump.tables).toEqual(expect.arrayContaining(['ledger_legs', 'ledger_transactions', 'ledger_rejections', 'outbox_events']));
    // y no es un detector mudo: sobre el mismo material con un canario añadido, grita
    expect(findLeaks('control', `${output}\n${CANARY.pan}`)).not.toEqual([]);
  });
});

describe('GAP conocido (plantilla de servicio, carril P1): la ruta que el cliente escribe se refleja', () => {
  // `ProblemFilter` copia la ruta de la petición en `instance` (RFC 9457) y el log de acceso (pino-http) registra la misma ruta. Un id con forma de PAN o con un nombre
  // en la URL (que la regla 90.2.2 prohíbe al cliente) vuelve en la respuesta a ESE cliente y queda en su log de acceso. No sale a terceros ni a eventos ni a la base.
  // `failing` pasa mientras el reflejo exista y FALLA cuando la plantilla sanee `instance`: entonces quitar `.failing` y sumar estas rutas a la prueba de arriba.
  it.failing.each([
    ['GET /holds/{PAN}', `/holds/${CANARY.pan}`],
    ['GET /holds/{nombre}', `/holds/${encodeURIComponent(CANARY.name)}`],
  ])('%s: la respuesta no repite el dato de la ruta', async (_name, path) => {
    const res = await ctx.as('pay-settlement').get(path);
    expect(res.status).toBe(404);
    expect(findLeaks('instance', JSON.stringify(res.body))).toEqual([]);
  });
});

describe('la Idempotency-Key con forma de PAN se rechaza antes de guardarse (@pay/idempotency, cerrado por P1)', () => {
  // Ver pay-settlement/test/sensitive-data.spec.ts. En el ledger la guardan `POST /holds/{id}/post` y `/void` (crear una retención y las transferencias se deduplican
  // por `business_ref` + `attempt` y no la guardan). Rechazada antes de ejecutar nada: la retención sigue pendiente y no se mueve dinero.
  it('POST /holds/{id}/post con un PAN como clave: 422 sin repetirlo, no se guarda y la retención NO se confirma', async () => {
    const m = merchantId();
    const fund = { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 500)] };
    expect((await ctx.as('pay-payments').post('/transactions', fund).set('idempotency-key', key())).status).toBe(201);
    const release = { business_ref: businessRef('release'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, `merchant:${m}:available`, 500, 'release')] };
    expect((await ctx.as('pay-settlement').post('/transactions', release).set('idempotency-key', key())).status).toBe(201);
    const hold = await ctx.as('pay-settlement').post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 1, currency: 'BOB', expires_in_seconds: 60 }).set('idempotency-key', key());
    expect(hold.status).toBe(201);
    const res = await ctx.as('pay-settlement').post(`/holds/${hold.body.id}/post`).set('idempotency-key', CANARY.pan);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('card_number_detected');
    expect(findLeaks('respuesta', JSON.stringify(res.body))).toEqual([]);
    expect((await ctx.as('pay-settlement').get(`/holds/${hold.body.id}`)).body.status).toBe('pending'); // no se ejecutó nada
    expect(findLeaks('filas de la base', (await dumpSchema(ctx.db.pool)).text)).toEqual([]);
  });
});
