import { join } from 'node:path';
import { serviceDb } from '../lib/db.ts';
import { ROOT } from '../lib/infra.ts';
import { OtlpSink } from '../lib/otlp-sink.ts';
import { scanSources, SYNTHETIC_PANS, type PanHit } from '../lib/pan-scan.ts';
import { freePorts } from '../lib/process.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { ALL_SERVICES } from '../lib/services.ts';
import { busSources, databaseSources, logSources, temporalSources, type CollectedSource } from '../lib/sensitive-sources.ts';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E7 — «Cobro con tarjeta por los campos alojados del PSP sin un solo PAN fuera de pay-vault» (P3·P4). Los 12 servicios REALES.
 *
 * LOS PAN SON SINTÉTICOS: números de prueba públicos de las marcas (Visa 4111…, Mastercard 5555…, Amex 3782…); ninguno es una tarjeta real ni de un titular. Nadie teclea datos reales.
 *
 * DOBLES DECLARADOS (nada de esto es el producto):
 *  - Los «campos alojados del PSP» son lib/hosted-fields-preload.cjs, cargado SOLO en el proceso de pay-vault: abre un puerto local que llama a `completeCapture` del backend `fake` del servicio
 *    (hoy el único: no hay ninguna ruta HTTP por la que un pagador entregue la tarjeta). El PAN va del «navegador» (esta prueba) al proceso de la bóveda, sin pasar por ningún otro servicio.
 *  - `pay-connectors` HOY NO llama a la bóveda ni usa el token con el banco (el conector `mock` ignora `card_token`): el intento queda `requires_action`. Por eso la prueba HACE DE pay-connectors
 *    (con su identidad de servicio) para el tramo que falta: `reveal` en la bóveda y autorización + captura en `pay-mockbank` (banco simulado) SOLO con el token.
 *  - Las trazas las recibe un colector OTLP del arnés (lib/otlp-sink.ts), no Jaeger.
 *
 * Qué prueba: (correcto) el PAN entra solo por los campos alojados y de ahí en adelante todo el sistema maneja el `tok_…`; (límite) el PAN pegado por error en cualquier campo que el comercio controla
 * (card_token, description, metadata, payer_name, Idempotency-Key, ruta, query) se rechaza y no se guarda; (inválido) solo pay-connectors puede hacer `reveal`; y al final se escanean logs, bus,
 * filas de TODAS las bases, historiales de Temporal y trazas: 0 apariciones del PAN (las bases y logs de pay-vault también: más estricto de lo pedido).
 */
describe('E7 — tarjeta por campos alojados, sin un PAN fuera de pay-vault', () => {
  const PAN = SYNTHETIC_PANS.visa;
  const KNOWN = Object.values(SYNTHETIC_PANS);
  const CANARY = 'e7-canary-marcador-no-pan';
  const sink = new OtlpSink();
  let stack: Stack | undefined;
  let hostedPort: number;
  let merchant: SeededMerchant;
  let token: string;
  let intentId: string;
  let chargeId: string;
  const liveTexts: string[] = []; // respuestas de la API que se revisan junto con las demás fuentes

  const edge = (method: string, path: string, init: { key?: string; json?: unknown } = {}) =>
    stack!.call('pay-edge', method, path, { headers: { authorization: `Bearer ${merchant.token}`, ...(init.key ? { 'idempotency-key': init.key } : {}) }, ...(init.json !== undefined ? { json: init.json } : {}), timeoutMs: 30_000 });
  const asService = (from: string, to: Parameters<Stack['callAs']>[1], method: string, path: string, options: Parameters<Stack['callAs']>[4] = {}) => stack!.callAs(from, to, method, path, options);
  const expectNoPan = (text: string) => expect(scanSources([{ source: 'respuesta', text }], KNOWN).hits).toEqual([]);

  beforeAll(async () => {
    await sink.listen();
    [hostedPort] = await freePorts(1);
    const otel = { OTEL_EXPORTER_OTLP_ENDPOINT: sink.endpoint, OTEL_BSP_SCHEDULE_DELAY: '300' };
    const envOverrides = Object.fromEntries(ALL_SERVICES.map((name) => [name, name === 'pay-vault' ? { ...otel, NODE_OPTIONS: `--require ${join(ROOT, 'e2e/lib/hosted-fields-preload.cjs')}`, E2E_HOSTED_FIELDS_PORT: String(hostedPort) } : otel]));
    stack = await startStack({ tolerateFailures: false, mockbank: true, envOverrides });
    merchant = await seedMerchant(stack, { label: 'COMERCIO E7 TARJETA (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
  }, 600_000);
  afterAll(async () => {
    try {
      if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
    } finally {
      await sink.close();
    }
  });

  /**
   * El pagador teclea la tarjeta en los campos alojados y se obtiene el token. Evita un hallazgo abierto de pay-mockbank (e2e/pending/e7-token-mockbank.e2e.ts): su validador de
   * `card_token` rechaza (422) un `tok_…` legítimo si tiene 12 dígitos decimales seguidos (≈2 % de los tokens de la bóveda). Si el token emitido cae en ese caso se descarta (se borra de la
   * bóveda) y se captura otra tarjeta; el resto de la prueba no cambia.
   */
  async function captureToken(attemptKey: string): Promise<{ token: string; sessionTexts: string[] }> {
    const texts: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const opened = await asService('pay-payments', 'pay-vault', 'POST', '/capture_sessions', { headers: { 'idempotency-key': `${attemptKey}-${attempt}` }, json: { merchant_id: merchant.merchantId, save_card: false, expires_in_seconds: 600 } });
      expect(opened.status).toBe(201);
      texts.push(opened.text);
      const sessionId = (opened.json as { id: string }).id;
      expect((opened.json as { status: string }).status).toBe('open');
      // El «navegador del pagador» entrega la tarjeta DIRECTO a los campos alojados (dentro de la bóveda).
      const typed = await fetch(`http://127.0.0.1:${hostedPort}/hosted/${sessionId}`, { method: 'POST', body: JSON.stringify({ number: PAN, exp_month: 12, exp_year: 2031, cvv: '123', holder_name: 'TITULAR SINTETICO' }) });
      expect(typed.status).toBe(200);
      const done = await until('la sesión de captura termina', () => asService('pay-payments', 'pay-vault', 'GET', `/capture_sessions/${sessionId}`), (r) => (r.json as { status: string }).status === 'completed', 30_000, 250);
      texts.push(done.text);
      expectNoPan(done.text);
      const issued = (done.json as { token: string }).token;
      expect(issued).toMatch(/^tok_[a-z0-9]{10,60}$/);
      if (!/(?:\d[ -]?){12,19}/.test(issued)) return { token: issued, sessionTexts: texts };
      expect((await asService('pay-payments', 'pay-vault', 'DELETE', `/tokens/${issued}`, { merchantId: merchant.merchantId })).status).toBe(204);
    }
    throw new Error('seis tokens seguidos con 12 dígitos decimales: no es azar');
  }

  it('CORRECTO: el pagador teclea la tarjeta en los campos alojados; la bóveda devuelve solo un token y metadatos (últimos 4, marca), nunca el número', async () => {
    const captured = await captureToken('e7-capture-session');
    token = captured.token;
    liveTexts.push(...captured.sessionTexts);
    const meta = await asService('pay-payments', 'pay-vault', 'GET', `/tokens/${token}`, { merchantId: merchant.merchantId });
    liveTexts.push(meta.text);
    expect(meta.json).toMatchObject({ token, brand: 'visa', last4: '1111', exp_month: 12 });
    expectNoPan(meta.text);
    expect(meta.text).not.toContain('123'); // el CVV se descarta: tampoco vuelve
  });

  it('CORRECTO: el comercio cobra con ese token por la API pública; el intento, su consulta y el listado no traen PAN', async () => {
    const created = await edge('POST', '/v1/payment_intents', { key: 'e7-card-intent-0001', json: { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'card', card_token: token }, metadata: { marcador: CANARY } } });
    expect(created.status).toBe(201);
    liveTexts.push(created.text);
    intentId = (created.json as { id: string }).id;
    expect(created.json).toMatchObject({ payment_method_type: 'card', amount_minor: 10_000 });
    expectNoPan(created.text);
    const got = await edge('GET', `/v1/payment_intents/${intentId}`);
    const list = await edge('GET', '/v1/payment_intents?limit=10');
    expect([got.status, list.status]).toEqual([200, 200]);
    liveTexts.push(got.text, list.text);
    expectNoPan(got.text + list.text);
    chargeId = (await serviceDb(stack!, 'connectors', (db) => db.query('SELECT id FROM connector_charges WHERE payment_intent_id = $1', [intentId]))).rows[0]!.id as string;
    expect(chargeId).toMatch(/^ch_[a-z0-9]{10,40}$/);
  });

  it('CORRECTO (doble: la prueba hace de pay-connectors): reveal entrega la tarjeta SOLO al conector y queda auditado; el banco simulado autoriza y captura con el token, sin ver el PAN', async () => {
    const revealed = await asService('pay-connectors', 'pay-vault', 'POST', `/tokens/${token}/reveal`, { merchantId: merchant.merchantId, headers: { 'idempotency-key': 'e7-reveal-0001' }, json: { charge_id: chargeId } });
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get('cache-control')).toBe('no-store');
    expect((revealed.json as { number: string }).number).toBe(PAN); // el ÚNICO lugar donde el número sale de la bóveda
    const audit = await serviceDb(stack!, 'vault', (db) => db.query('SELECT caller, outcome, charge_id FROM reveal_audit WHERE token = $1', [token]));
    expect(audit.rows).toEqual([{ caller: 'pay-connectors', outcome: expect.any(String), charge_id: chargeId }]);

    const bank = (method: string, path: string, json?: unknown) => asService('pay-connectors', 'pay-mockbank', method, path, { payMode: 'test', ...(json !== undefined ? { json } : {}) });
    const authorized = await bank('POST', '/sandbox/card-authorizations', { reference: chargeId, amount_minor: 10_000, card_token: token });
    if (![201, 200].includes(authorized.status)) throw new Error(`autorización en el banco: ${authorized.status} ${authorized.text}`);
    expectNoPan(authorized.text);
    const captured = await bank('POST', `/sandbox/card-authorizations/${chargeId}/capture`, {});
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({ status: 'captured' });
    expectNoPan(captured.text);
  });

  it('LÍMITE: un PAN pegado por error en cualquier campo del comercio (seguido, con espacios, guiones o puntos; Visa, Mastercard, Amex) se rechaza sin repetirlo y no crea ningún intento', async () => {
    const before = (await serviceDb(stack!, 'payments', (db) => db.query('SELECT count(*)::int AS n FROM payment_intents'))).rows[0]!.n as number;
    const forms = ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '4111.1111.1111.1111', SYNTHETIC_PANS.mastercard, '5555 5555 5555 4444', SYNTHETIC_PANS.amex, '3782 822463 10005'];
    let n = 0;
    for (const form of forms) {
      const bodies = [
        { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'card', card_token: form } },
        { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' }, description: `pago con ${form}` },
        { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' }, metadata: { nota: form } },
        { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' }, payer_name: form },
      ];
      for (const json of bodies) {
        n += 1;
        const res = await edge('POST', '/v1/payment_intents', { key: `e7-hostil-body-${String(n).padStart(4, '0')}`, json });
        liveTexts.push(res.text);
        const problem = res.json as { code?: string; errors?: { field: string; code: string }[] };
        if (res.status !== 422 || problem.code !== 'validation_failed' || !problem.errors?.some((e) => e.code === 'card_number_detected')) throw new Error(`hostil ${JSON.stringify(json).replace(/\d{4}/g, 'dddd')} => ${res.status} ${res.text}`);
        expectNoPan(res.text);
      }
    }
    // La Idempotency-Key, la ruta y la query también las escribe el cliente.
    const key = await edge('POST', '/v1/payment_intents', { key: `e7-${PAN}-key`, json: { amount_minor: 10_000, currency: 'BOB', payment_method: { type: 'qr' } } });
    const path = await edge('GET', `/v1/payment_intents/${PAN}`);
    const query = await edge('GET', `/v1/payment_intents?limit=${PAN}`);
    // Decisión de pay-edge: una Idempotency-Key con forma de PAN NO se rechaza (daba falsos positivos con claves hexadecimales) sino que se guarda ENMASCARADA (`masked-<sha256>`);
    // el cobro se crea y el PAN no queda en la tabla de idempotencia, en los logs ni en las trazas: lo comprueba el escaneo final. Ruta y query sí se rechazan.
    liveTexts.push(key.text, path.text, query.text);
    expect(key.status).toBe(201);
    for (const res of [path, query]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    for (const res of [key, path, query]) expectNoPan(res.text);
    const after = (await serviceDb(stack!, 'payments', (db) => db.query('SELECT count(*)::int AS n FROM payment_intents'))).rows[0]!.n as number;
    expect(after).toBe(before + 1); // solo el de la clave enmascarada: ninguno de los 32 cuerpos con PAN creó un intento
  });

  it('INVÁLIDO: solo pay-connectors puede hacer reveal (pay-payments y pay-edge reciben 403), y el token de otro comercio no existe (404)', async () => {
    const reveal = (from: string, merchantId: string) => asService(from, 'pay-vault', 'POST', `/tokens/${token}/reveal`, { merchantId, headers: { 'idempotency-key': `e7-reveal-${from}-0001` }, json: { charge_id: chargeId } });
    for (const from of ['pay-payments', 'pay-edge']) {
      const res = await reveal(from, merchant.merchantId);
      liveTexts.push(res.text);
      expect(res.status).toBe(403);
      expectNoPan(res.text);
    }
    const other = await reveal('pay-connectors', 'mc_otrocomercio00000001');
    expect(other.status).toBe(404);
    expectNoPan(other.text);
    // Una Idempotency-Key con forma de PAN ni siquiera entra a la tabla de idempotencia de la bóveda.
    const bad = await asService('pay-payments', 'pay-vault', 'POST', '/capture_sessions', { headers: { 'idempotency-key': `cap-${PAN}` }, json: { merchant_id: merchant.merchantId, expires_in_seconds: 600 } });
    expect(bad.status).toBe(422);
    expectNoPan(bad.text);
  });

  it('ESCANEO: 0 apariciones del PAN en logs, bus, filas de todas las bases, historiales de Temporal y trazas (y el escaneo no fue vacío)', async () => {
    const s = stack!;
    // El detector funciona sobre el mismo canal: un texto con el PAN SÍ da hallazgo (control positivo), y enmascarado.
    const control = scanSources([{ source: 'control', text: `x ${PAN} y` }], KNOWN);
    expect(control.hits).toHaveLength(1);

    // Antes de parar: bus, bases y Temporal (parar borra las bases y los streams).
    const bus = await busSources(s);
    const dbs = await databaseSources(s);
    const temporal = await temporalSources(s, [`payment-${intentId}`]);
    const live = bus.length + dbs.length + temporal.length;
    expect(live).toBeGreaterThan(30);
    // No vacío: el marcador del intento está en la base de pagos y en el bus (los colectores leen datos de verdad), y la bóveda tiene su token.
    const text = (list: CollectedSource[], prefix: string) => list.filter((x) => x.source.startsWith(prefix)).map((x) => x.text).join('\n');
    expect(text(dbs, 'db:pay_payments.')).toContain(CANARY);
    expect(text(bus, 'nats:PAY_PAYMENTS')).toContain(intentId); // el bus lleva el intento (los eventos no llevan metadata)
    expect(text(dbs, 'db:pay_vault.')).toContain(token);
    expect(dbs.map((d) => d.source.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i)).toHaveLength(ALL_SERVICES.length);
    expect(temporal[0]!.items).toBeGreaterThan(3);
    const rows = dbs.reduce((total, d) => total + d.items, 0);
    const messages = bus.reduce((total, d) => total + d.items, 0);

    const apiTexts: CollectedSource[] = [{ source: 'respuestas-api', text: liveTexts.join('\n'), items: liveTexts.length }];
    const pre = scanSources([...bus, ...dbs, ...temporal, ...apiTexts], KNOWN);
    // Se imprime el resumen (sin PAN) para que quede en la evidencia.
    process.stdout.write(`E7 escaneo previo al cierre: ${dbs.length} tablas / ${rows} filas, ${bus.length} streams / ${messages} mensajes, ${temporal.length} historial(es) Temporal, ${liveTexts.length} respuestas de la API\n`);
    expect(pre.hits).toEqual([]);

    // Parar el stack (SIGTERM: los servicios vacían logs y spans) y escanear logs y trazas.
    expect((await stopStack(s, { keepLogs: true })).leftoverPids).toEqual([]);
    const logs = logSources(s);
    const lines = logs.reduce((total, l) => total + l.items, 0);
    expect(logs.length).toBeGreaterThanOrEqual(ALL_SERVICES.length);
    expect(lines).toBeGreaterThan(200);
    expect(text(logs, 'log:pay-edge')).toContain('/v1/payment_intents'); // el log de acceso del borde vio las peticiones hostiles
    const traces: CollectedSource = { source: 'trazas-otlp', text: sink.text(), items: sink.bodies.length };
    for (const service of ['pay-edge', 'pay-vault', 'pay-payments', 'pay-connectors']) expect(sink.mentions(service)).toBe(true); // llegaron spans de los servicios del flujo
    expect(sink.text()).toContain('/v1/payment_intents');
    const post = scanSources([...logs, traces], KNOWN);
    process.stdout.write(`E7 escaneo posterior al cierre: ${logs.length} logs / ${lines} líneas, ${sink.bodies.length} envíos OTLP (${sink.bodies.reduce((t, b) => t + b.body.length, 0)} bytes)\n`);
    const hits: PanHit[] = [...pre.hits, ...post.hits];
    expect(hits).toEqual([]);
    stack = undefined;
  });
});
