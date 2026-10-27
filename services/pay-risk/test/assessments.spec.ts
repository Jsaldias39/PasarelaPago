import request from 'supertest';
import { createTestContext, type TestContext } from './support/app';
import {
  SANCTIONED_ORG, SANCTIONED_ORG_TYPO, assessmentBody, getAssessment, newIntent, newMerchant, post, publishRules, rows, uniqueKey, verified,
} from './support/http';
import { entity, json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

let ctx: TestContext;
// Cribado instantáneo y determinista para las pruebas de CONCURRENCIA de los límites: ahí se prueba el candado, no la capacidad
// de Watchman (esa se mide aparte en latency.spec.ts contra el Watchman real). Es un [DOBLE] declarado.
let fastDouble: WatchmanDouble;
let fast: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  fastDouble = await startWatchmanDouble((_req, res) => json(res, { entities: null }));
  fast = await createTestContext({ settings: { watchmanUrl: fastDouble.url } });
});
afterAll(async () => {
  await ctx.close();
  await fast.close();
  await fastDouble.close();
});

/** El reloj solo avanza: un conjunto de reglas nuevo no puede empezar antes que el anterior. */
const nextDay = (time = '18:00:00'): string => {
  const date = new Date(ctx.clock.now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
  ctx.clock.now = new Date(`${date}T${time}Z`);
  return date;
};

const evaluate = async (body: Record<string, unknown>, status = 201) => verified(ctx.contract, 'post', '/assessments', await post(ctx, body), status);
const stored = async (id: string) => (await rows(ctx, 'SELECT * FROM risk_assessments WHERE id = $1', [id]))[0];

describe('POST /assessments (REQ-P5-5, P5.H2.M2–M5)', () => {
  describe('decisiones con el Watchman REAL', () => {
    it('sin límites cargados y nombre limpio: allow `no_limits_configured`, screened true, regla v1, y el GET devuelve lo mismo', async () => {
      const body = await evaluate(assessmentBody());
      expect(body).toMatchObject({ object: 'risk_assessment', decision: 'allow', reason_code: 'no_limits_configured', rule_version: 1, screened: true });
      const again = verified(ctx.contract, 'get', `/assessments/${body.id}`, await getAssessment(ctx, body.id), 200);
      expect(again).toEqual(body);
    });

    it('entrada de la lista pública (Hizballah) ⇒ deny `sanctions_match`; el rastro guarda puntaje, lista e id de la entrada pública', async () => {
      const body = await evaluate(assessmentBody({ screening: { name: SANCTIONED_ORG } }));
      expect(body).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
      const row = await stored(body.id);
      expect(Number(row.screening_top_score)).toBeGreaterThanOrEqual(0.8);
      expect(row).toMatchObject({ screening_list: 'us_ofac', reason_codes: ['sanctions_match'] });
      expect(row.screening_source_id).toMatch(/^\d+$/);
    });

    it('coincidencia aproximada ⇒ review `sanctions_possible_match` (entre el umbral de revisión y el de rechazo)', async () => {
      expect(await evaluate(assessmentBody({ screening: { name: SANCTIONED_ORG_TYPO } }))).toMatchObject({ decision: 'review', reason_code: 'sanctions_possible_match', screened: true });
    });

    it('sin nombre que cribar ⇒ review `screening_not_provided`, screened false (nunca allow)', async () => {
      expect(await evaluate(assessmentBody({ screening: null }))).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
    });

    it('el nombre se recorta antes de cribar: los espacios alrededor no cambian la decisión', async () => {
      expect(await evaluate(assessmentBody({ screening: { name: `   ${SANCTIONED_ORG}  ` } }))).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match' });
    });
  });

  describe('Watchman caído (inválido): la decisión nunca es allow', () => {
    it('inalcanzable ⇒ review `screening_unavailable` con screened false, y queda en el rastro', async () => {
      const down = await createTestContext({ settings: { watchmanUrl: 'http://127.0.0.1:1' } });
      try {
        const res = await post(down, assessmentBody());
        const body = verified(down.contract, 'post', '/assessments', res, 201);
        expect(body).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
        expect((await down.db.pool.query('SELECT decision, screened FROM risk_assessments WHERE id = $1', [body.id])).rows).toEqual([{ decision: 'review', screened: false }]);
      } finally {
        await down.close();
      }
    });

    it('la base impide un `allow` sin cribado aunque alguien escriba directo (restricción de la tabla)', async () => {
      await expect(
        ctx.db.pool.query(
          `INSERT INTO risk_assessments (id, caller_service, request_key, merchant_id, payment_intent_id, amount_minor, currency, method, decision, reason_code, reason_codes, rule_version, screened, duration_ms, created_at)
           VALUES ('ra_abcdefghij12', 'pay-payments', 'k-directa', 'mc_abcdefghij12', 'pi_abcdefghij12', 1, 'BOB', 'qr', 'allow', 'ok', '{}', 1, false, 1, now())`,
        ),
      ).rejects.toThrow(/allow_requires_screening/);
    });
  });

  describe('idempotencia (Idempotency-Key)', () => {
    it('repetir la misma petición devuelve 200 con la MISMA decisión y no escribe otro rastro', async () => {
      const body = assessmentBody();
      const key = uniqueKey();
      const first = await post(ctx, body, key);
      const second = await post(ctx, body, key);
      expect([first.status, second.status]).toEqual([201, 200]);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await rows(ctx, 'SELECT 1 FROM risk_assessments WHERE payment_intent_id = $1', [body.payment_intent_id])).toHaveLength(1);
    });

    it('la misma clave con OTRO cuerpo (importe, o solo el nombre) es 422 `idempotency_key_reused`', async () => {
      const body = assessmentBody();
      const key = uniqueKey();
      await post(ctx, body, key);
      const otherAmount = await post(ctx, { ...body, amount_minor: 10_001 }, key);
      const otherName = await post(ctx, { ...body, screening: { name: 'Otro Nombre Sintético' } }, key);
      expect([otherAmount.status, otherAmount.body.code]).toEqual([422, 'idempotency_key_reused']);
      expect([otherName.status, otherName.body.code]).toEqual([422, 'idempotency_key_reused']);
    });

    it('sin Idempotency-Key es 400 y no se escribe nada', async () => {
      const res = await request(ctx.server).post('/assessments').set('x-service-id', 'pay-payments').send(assessmentBody());
      expect([res.status, res.body.code]).toEqual([400, 'idempotency_key_required']);
    });

    it('una clave mal formada es 422 sin repetir el valor', async () => {
      const res = await request(ctx.server).post('/assessments').set('x-service-id', 'pay-payments').set('idempotency-key', 'corta').send(assessmentBody());
      expect(res.status).toBe(422);
    });

    it('5 llamadas simultáneas con la misma clave: un solo rastro; las demás reciben 409 (en curso) o la misma decisión', async () => {
      const body = assessmentBody();
      const key = uniqueKey();
      const results = await Promise.all(Array.from({ length: 5 }, () => post(fast, body, key)));
      expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
      expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
      const created = results.find((r) => r.status === 201)!.body.id;
      expect(results.filter((r) => r.status !== 409).every((r) => r.body.id === created)).toBe(true);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'idempotency_request_in_progress')).toBe(true);
      expect(await rows(fast, 'SELECT 1 FROM risk_assessments WHERE payment_intent_id = $1', [body.payment_intent_id])).toHaveLength(1);
      // Y tras terminar, repetir devuelve la decisión guardada.
      const after = await post(fast, body, key);
      expect([after.status, after.body.id]).toEqual([200, created]);
    });

    it('la repetición conserva la versión de reglas original aunque se publique otra después (reproducible)', async () => {
      const body = assessmentBody({ amount_minor: 5000 });
      const key = uniqueKey();
      const first = (await post(ctx, body, key)).body;
      expect(first.rule_version).toBe(1);
      const v = await publishRules(ctx, { max_amount_minor: 1000 });
      const replay = await post(ctx, body, key);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first);
      // Una evaluación NUEVA ya usa la versión nueva y rechaza ese importe.
      expect(await evaluate(assessmentBody({ amount_minor: 5000 }))).toMatchObject({ decision: 'deny', reason_code: 'amount_over_limit', rule_version: v.version });
    });

    it('con el Watchman de pruebas contado, repetir no vuelve a cribar', async () => {
      const double = await startWatchmanDouble((_req, res) => json(res, { entities: null }));
      const counted = await createTestContext({ settings: { watchmanUrl: double.url } });
      try {
        const body = assessmentBody();
        const key = uniqueKey();
        await post(counted, body, key);
        const callsAfterFirst = double.requests.length;
        expect(callsAfterFirst).toBe(3); // comercio (empresa) + pagador sin tipo (persona y empresa)
        await post(counted, body, key);
        expect(double.requests.length).toBe(callsAfterFirst);
      } finally {
        await counted.close();
        await double.close();
      }
    });
  });

  describe('límites (D-23): configurables, versionados, sin valores por defecto', () => {
    // Cada prueba usa comercios y pagadores propios; los conjuntos de reglas son globales, así que se publican en orden.
    it('límite por transacción: el borde se permite y un centavo más se rechaza', async () => {
      await publishRules(ctx, { max_amount_minor: 20_000 });
      expect(await evaluate(assessmentBody({ amount_minor: 20_000 }))).toMatchObject({ decision: 'allow', reason_code: 'ok' });
      expect(await evaluate(assessmentBody({ amount_minor: 20_001 }))).toMatchObject({ decision: 'deny', reason_code: 'amount_over_limit' });
    });

    it('velocidad por pagador: el 4.º intento distinto dentro de la ventana se rechaza; repetir el mismo intento no cuenta; la ventana se desliza', async () => {
      await publishRules(ctx, { payer_velocity: { max: 3, window_seconds: 60 } });
      const merchant_id = newMerchant();
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const attempt = (extra: Record<string, unknown> = {}) => evaluate(assessmentBody({ merchant_id, payer_fingerprint, ...extra }));
      const intents = [newIntent(), newIntent(), newIntent()];
      for (const payment_intent_id of intents) expect(await attempt({ payment_intent_id })).toMatchObject({ decision: 'allow' });
      // Reevaluar un intento ya evaluado (otra clave) no suma uno más.
      expect(await attempt({ payment_intent_id: intents[0] })).toMatchObject({ decision: 'allow' });
      expect(await attempt()).toMatchObject({ decision: 'deny', reason_code: 'velocity_exceeded' });
      // Otro pagador no se ve afectado.
      expect(await evaluate(assessmentBody({ merchant_id, payer_fingerprint: `otra-${uniqueKey()}` }))).toMatchObject({ decision: 'allow' });
      // Pasada la ventana, vuelve a permitir.
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
      expect(await attempt()).toMatchObject({ decision: 'allow' });
    });

    it('velocidad por comercio: independiente del pagador y de otros comercios', async () => {
      await publishRules(ctx, { merchant_velocity: { max: 2, window_seconds: 300 } });
      const merchant_id = newMerchant();
      expect(await evaluate(assessmentBody({ merchant_id }))).toMatchObject({ decision: 'allow' });
      expect(await evaluate(assessmentBody({ merchant_id }))).toMatchObject({ decision: 'allow' });
      expect(await evaluate(assessmentBody({ merchant_id }))).toMatchObject({ decision: 'deny', reason_code: 'merchant_velocity_exceeded' });
      expect(await evaluate(assessmentBody({ merchant_id: newMerchant() }))).toMatchObject({ decision: 'allow' });
    });

    it('simultaneidad: 12 intentos distintos del mismo pagador con tope 3 ⇒ exactamente 3 allow y 9 deny (candado por pagador)', async () => {
      await publishRules(fast, { payer_velocity: { max: 3, window_seconds: 600 } });
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const merchant_id = newMerchant();
      const results = await Promise.all(Array.from({ length: 12 }, () => post(fast, assessmentBody({ merchant_id, payer_fingerprint }))));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const decisions = results.map((r) => r.body.decision);
      expect({ allow: decisions.filter((d) => d === 'allow').length, deny: decisions.filter((d) => d === 'deny').length }).toEqual({ allow: 3, deny: 9 });
    });

    it('simultaneidad: tope diario por comercio 25.000 con intentos de 10.000 ⇒ solo 2 pasan', async () => {
      await publishRules(fast, { merchant_daily_amount_minor: 25_000 });
      const merchant_id = newMerchant();
      const results = await Promise.all(Array.from({ length: 8 }, () => post(fast, assessmentBody({ merchant_id, amount_minor: 10_000 }))));
      const decisions = results.map((r) => r.body.decision);
      expect(decisions.filter((d) => d === 'allow')).toHaveLength(2);
      expect(results.filter((r) => r.body.decision === 'deny').every((r) => r.body.reason_code === 'daily_limit_exceeded')).toBe(true);
    });

    it('tope diario por pagador: lo rechazado no cuenta, la suma llega justo al tope y a las 24 h se libera', async () => {
      await publishRules(ctx, { payer_daily_amount_minor: 25_000 });
      const merchant_id = newMerchant();
      const payer_fingerprint = `huella-${uniqueKey()}`;
      const attempt = (amount_minor: number) => evaluate(assessmentBody({ merchant_id, payer_fingerprint, amount_minor }));
      expect(await attempt(10_000)).toMatchObject({ decision: 'allow' });
      expect(await attempt(10_000)).toMatchObject({ decision: 'allow' });
      expect(await attempt(10_000)).toMatchObject({ decision: 'deny', reason_code: 'payer_daily_limit_exceeded' });
      expect(await attempt(5_000)).toMatchObject({ decision: 'allow' }); // 20.000 + 5.000 = 25.000: justo el tope
      expect(await attempt(1)).toMatchObject({ decision: 'deny', reason_code: 'payer_daily_limit_exceeded' });
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 24 * 3600_000 + 1000);
      expect(await attempt(10_000)).toMatchObject({ decision: 'allow' });
    });

    it('un límite por pagador sin huella del pagador ⇒ review `payer_unidentified` (no se deja pasar)', async () => {
      await publishRules(ctx, { payer_velocity: { max: 5, window_seconds: 60 } });
      expect(await evaluate(assessmentBody())).toMatchObject({ decision: 'review', reason_code: 'payer_unidentified' });
    });

    it('horario permitido en hora de La Paz (UTC-4): el inicio es inclusivo y el fin exclusivo', async () => {
      await publishRules(ctx, { hours: { from: 8, to: 20 } });
      const date = nextDay('12:00:00');
      const at = async (utc: string) => {
        ctx.clock.now = new Date(`${date}T${utc}Z`);
        return evaluate(assessmentBody());
      };
      expect(await at('12:00:00')).toMatchObject({ decision: 'allow' }); // 08:00 local
      expect(await at('11:59:59')).toMatchObject({ decision: 'review', reason_code: 'outside_allowed_hours' }); // 07:59:59
      expect(await at('23:59:59')).toMatchObject({ decision: 'allow' }); // 19:59:59
      expect(await at('00:00:00')).toMatchObject({ decision: 'review', reason_code: 'outside_allowed_hours' }); // 20:00 local del día anterior
      expect(await at('03:00:00')).toMatchObject({ decision: 'review' }); // 23:00 local
      nextDay();
    });

    it('varias reglas a la vez: gana el motivo más grave y TODOS quedan en el rastro', async () => {
      await publishRules(ctx, { max_amount_minor: 1000, hours: { from: 8, to: 20 } });
      nextDay('03:00:00');
      const body = await evaluate(assessmentBody({ amount_minor: 5000, screening: { name: SANCTIONED_ORG_TYPO } }));
      expect(body).toMatchObject({ decision: 'deny', reason_code: 'amount_over_limit' });
      expect((await stored(body.id)).reason_codes).toEqual(['amount_over_limit', 'sanctions_possible_match', 'outside_allowed_hours']);
      nextDay();
    });

    it('una versión con vigencia futura no rige todavía', async () => {
      const before = (await request(ctx.server).get('/health/live')).status;
      expect(before).toBe(200);
      const current = (await rows(ctx, 'SELECT max(version) AS v FROM risk_rule_sets WHERE effective_from <= $1', [ctx.clock.now]))[0].v;
      const future = await publishRules(ctx, { max_amount_minor: 1, effective_from: new Date(ctx.clock.now.getTime() + 3600_000).toISOString() });
      expect(future.version).toBeGreaterThan(current);
      expect((await evaluate(assessmentBody({ amount_minor: 50_000 }))).rule_version).toBe(current);
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 3601_000);
      expect(await evaluate(assessmentBody({ amount_minor: 50_000 }))).toMatchObject({ rule_version: future.version, decision: 'deny', reason_code: 'amount_over_limit' });
      nextDay();
    });
  });

  describe('validación y autorización', () => {
    it.each([
      ['moneda distinta de BOB', { currency: 'USD' }],
      ['importe 0', { amount_minor: 0 }],
      ['importe negativo', { amount_minor: -5 }],
      ['importe decimal', { amount_minor: 10.5 }],
      ['importe sobre el máximo seguro', { amount_minor: 9007199254740992 }],
      ['importe como texto', { amount_minor: '100' }],
      ['medio de pago inexistente', { method: 'efectivo' }],
      ['id de comercio mal formado', { merchant_id: 'MC_1' }],
      ['id de intento mal formado', { payment_intent_id: 'pi_' }],
      ['campo de más', { admin: true }],
      ['nombre vacío', { screening: { name: '' } }],
      ['nombre de 201 caracteres', { screening: { name: 'a'.repeat(201) } }],
      ['screening con campo de más', { screening: { name: 'x', dob: '1980-01-01' } }],
      ['huella de 129 caracteres', { payer_fingerprint: 'h'.repeat(129) }],
    ])('inválido: %s ⇒ 422 sin rastro y sin repetir lo enviado', async (_name, override) => {
      const before = (await rows(ctx, 'SELECT count(*)::int AS n FROM risk_assessments'))[0].n;
      const res = await post(ctx, assessmentBody(override as never));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      // El error nombra el campo, nunca el valor enviado.
      expect(JSON.stringify(res.body)).not.toMatch(/1980|aaaaaaaa|efectivo/);
      expect((await rows(ctx, 'SELECT count(*)::int AS n FROM risk_assessments'))[0].n).toBe(before);
    });

    it('el contrato admite nombres en blanco y una huella vacía: no se rechazan, se tratan como ausentes (D-29: el del comercio falta ⇒ review; el del pagador falta ⇒ no pasa nada)', async () => {
      const own = await createTestContext(); // reglas propias: v1 «sin límites»
      try {
        const ask = async (body: Record<string, unknown>) => verified(own.contract, 'post', '/assessments', await post(own, body), 201);
        expect(await ask(assessmentBody({ screening: { merchant_name: '    ' } }))).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
        expect(await ask(assessmentBody({ screening: { name: '    ' } }))).toMatchObject({ decision: 'allow', screened: true }); // pagador en blanco = invitado sin nombre
        const emptyPrint = await ask(assessmentBody({ payer_fingerprint: '' }));
        expect(emptyPrint).toMatchObject({ decision: 'allow', reason_code: 'no_limits_configured', screened: true });
        expect((await own.db.pool.query('SELECT payer_hash FROM risk_assessments WHERE id = $1', [emptyPrint.id])).rows[0].payer_hash).toBeNull();
        await publishRules(own, { payer_velocity: { max: 5, window_seconds: 60 } });
        expect(await ask(assessmentBody({ payer_fingerprint: '' }))).toMatchObject({ decision: 'review', reason_code: 'payer_unidentified' });
      } finally {
        await own.close();
      }
    });

    it('faltan campos obligatorios ⇒ 422 con el campo señalado', async () => {
      const res = await post(ctx, { currency: 'BOB' });
      expect(res.status).toBe(422);
      expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['amount_minor', 'merchant_id', 'method', 'payment_intent_id']);
    });

    it('solo pay-payments puede evaluar y consultar: sin identidad o con otro servicio es 403', async () => {
      const created = await evaluate(assessmentBody());
      for (const service of [undefined, 'pay-edge', 'pay-backoffice', 'pay-ledger', 'pay-risk']) {
        const create = request(ctx.server).post('/assessments').set('idempotency-key', uniqueKey());
        if (service) create.set('x-service-id', service);
        expect({ service, create: (await create.send(assessmentBody())).status }).toEqual({ service, create: 403 });
        const read = request(ctx.server).get(`/assessments/${created.id}`);
        if (service) read.set('x-service-id', service);
        expect({ service, read: (await read).status }).toEqual({ service, read: 403 });
      }
    });

    it('GET: inexistente o mal formado ⇒ 404; el rastro de otro servicio llamador no se ve', async () => {
      expect((await getAssessment(ctx, 'ra_noexiste0000000000')).status).toBe(404);
      for (const bad of ['x', 'ra_', '../etc', 'ra_ABC', `ra_${'a'.repeat(41)}`]) expect({ bad, status: (await getAssessment(ctx, bad)).status }).toEqual({ bad, status: 404 });
      await ctx.db.pool.query(
        `INSERT INTO risk_assessments (id, caller_service, request_key, merchant_id, payment_intent_id, amount_minor, currency, method, decision, reason_code, reason_codes, rule_version, screened, duration_ms, created_at)
         VALUES ('ra_ajenoajenoajeno', 'pay-otro', 'k-ajena', 'mc_abcdefghij12', 'pi_abcdefghij12', 1, 'BOB', 'qr', 'review', 'screening_unavailable', '{screening_unavailable}', 1, false, 1, now())`,
      );
      expect((await getAssessment(ctx, 'ra_ajenoajenoajeno')).status).toBe(404);
    });
  });
});

describe('rastro auditable (P5.H2.M5) y privacidad (regla 90.2)', () => {
  const NAME = 'CENTINELA-NOMBRE-ACME-777';
  const FINGERPRINT = 'CENTINELA-HUELLA-PAGADOR-777';

  it('cada decisión deja su rastro, con la versión de reglas y sin el nombre ni la huella en claro', async () => {
    const calls = Array.from({ length: 6 }, (_, i) => assessmentBody({ screening: i % 2 === 0 ? { name: `${NAME}-${i}` } : { name: SANCTIONED_ORG }, payer_fingerprint: `${FINGERPRINT}-${i % 2}` }));
    const before = (await rows(ctx, 'SELECT count(*)::int AS n FROM risk_assessments'))[0].n;
    const responses = [];
    for (const call of calls) responses.push(verified(ctx.contract, 'post', '/assessments', await post(ctx, call), 201));

    expect((await rows(ctx, 'SELECT count(*)::int AS n FROM risk_assessments'))[0].n).toBe(before + calls.length);
    for (const [i, response] of responses.entries()) {
      const row = await stored(response.id);
      expect(row).toMatchObject({ decision: response.decision, reason_code: response.reason_code, rule_version: response.rule_version, screened: response.screened, payment_intent_id: calls[i].payment_intent_id, merchant_id: calls[i].merchant_id });
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row.payer_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // La misma huella da el mismo hash (sirve para límites por pagador); huellas distintas, hashes distintos.
    const hashes = await Promise.all(responses.map(async (r) => (await stored(r.id)).payer_hash as string));
    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[1]);

    const dumps = [
      ...(await rows(ctx, 'SELECT row_to_json(t)::text AS j FROM risk_assessments t')).map((r) => r.j),
      ...(await rows(ctx, 'SELECT row_to_json(t)::text AS j FROM idempotency_keys t')).map((r) => r.j),
      ...(await rows(ctx, 'SELECT row_to_json(t)::text AS j FROM risk_rule_sets t')).map((r) => r.j),
      JSON.stringify(responses),
      ctx.logs.join('\n'),
    ].join('\n');
    expect(dumps.length).toBeGreaterThan(0);
    expect(dumps).not.toContain('CENTINELA');
  });

  it('un error de validación o de autorización tampoco devuelve ni registra el nombre', async () => {
    const bad = await post(ctx, assessmentBody({ screening: { name: `${NAME}-x` }, amount_minor: -1 }));
    const denied = await post(ctx, assessmentBody({ screening: { name: `${NAME}-y` } }), uniqueKey(), 'pay-edge');
    expect([bad.status, denied.status]).toEqual([422, 403]);
    expect(JSON.stringify([bad.body, denied.body]) + ctx.logs.join('\n')).not.toContain('CENTINELA');
  });

  it('el rastro es INMUTABLE: UPDATE, DELETE y TRUNCATE fallan aunque se llegue con SQL directo', async () => {
    const body = await evaluate(assessmentBody());
    await expect(ctx.db.pool.query(`UPDATE risk_assessments SET decision = 'deny' WHERE id = $1`, [body.id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM risk_assessments WHERE id = $1', [body.id])).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('TRUNCATE risk_assessments')).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('UPDATE risk_rule_sets SET max_amount_minor = 1 WHERE version = 1')).rejects.toThrow(/inmutable/);
    await expect(ctx.db.pool.query('DELETE FROM risk_rule_sets')).rejects.toThrow(/inmutable/);
    expect((await stored(body.id)).decision).toBe(body.decision);
  });

  it('el esquema no tiene columnas capaces de guardar el nombre, y la huella es un HMAC', async () => {
    const columns = (await rows(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'risk_assessments' ORDER BY ordinal_position`)).map((r) => r.column_name);
    expect(columns).toEqual([
      'id', 'caller_service', 'request_key', 'merchant_id', 'payment_intent_id', 'amount_minor', 'currency', 'method', 'payer_hash', 'decision', 'reason_code',
      'reason_codes', 'rule_version', 'screened', 'screening_top_score', 'screening_list', 'screening_source_id', 'screening_party', 'duration_ms', 'created_at',
    ]);
  });
});

describe('[DOBLE] de Watchman en el flujo completo', () => {
  let double: WatchmanDouble;
  let withDouble: TestContext;
  beforeAll(async () => {
    double = await startWatchmanDouble((_req, res) => json(res, { entities: [entity(0.7)] }));
    withDouble = await createTestContext({ settings: { watchmanUrl: double.url } });
  });
  afterAll(async () => {
    await withDouble.close();
    await double.close();
  });

  it('un puntaje entre umbrales ⇒ review; con un 5xx ⇒ review `screening_unavailable`; con 0,95 ⇒ deny — y siempre con rastro', async () => {
    const ask = async () => verified(withDouble.contract, 'post', '/assessments', await post(withDouble, assessmentBody()), 201);
    expect(await ask()).toMatchObject({ decision: 'review', reason_code: 'sanctions_possible_match', screened: true });
    double.behavior = (_req, res) => json(res, {}, 500);
    expect(await ask()).toMatchObject({ decision: 'review', reason_code: 'screening_unavailable', screened: false });
    double.behavior = (_req, res) => json(res, { entities: [entity(0.95)] });
    expect(await ask()).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
    expect((await withDouble.db.pool.query('SELECT count(*)::int AS n FROM risk_assessments')).rows[0].n).toBe(3);
  });
});
