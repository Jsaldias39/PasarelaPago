#!/usr/bin/env node
/**
 * Gate «Datos sensibles» (PLAN-MAESTRO §7, regla 90.2): sin PAN, CVV, documento ni nombre en LOGS, TRAZAS, EVENTOS ni ERRORES.
 *
 * Reproducible:  yarn build (en pay-connectors, pay-qr y pay-mockbank) y luego  node docs/trabajo/ola-3/P4/scripts/sensitive-data-scan.mjs
 *
 * Qué hace: lanza los TRES servicios como procesos reales (`dist/main.js`) con el rol de base de cada uno (el del Compose) sobre un esquema propio y
 * descartable, con LOG_LEVEL=trace y un exportador OTLP que apunta a un receptor local. Les manda tráfico con valores CENTINELA (un PAN, el mismo PAN
 * con espacios y con guiones, un CVV, un documento y un nombre) por cuerpo, URL, query y cabeceras, en peticiones válidas, inválidas y hostiles.
 * Luego busca cada centinela en cada canal: registros (stdout/stderr), respuestas de error (cuerpo y cabeceras), trazas (lo que exportó OpenTelemetry),
 * eventos (outbox) y claves de idempotencia, y un volcado de TODAS las columnas de texto de la base propia.
 *
 * Control positivo: antes de buscar, el mismo escáner tiene que ENCONTRAR un centinela plantado a propósito; si no, el resultado no vale.
 * Sale con código ≠ 0 si algún centinela aparece en logs, trazas, eventos, errores o en cualquier columna de la base.
 * Los valores son SINTÉTICOS (el PAN es el número de prueba público 4111 1111 1111 1111); nunca hay datos reales.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const HOST = process.env.PAY_DB_HOST ?? '127.0.0.1';
const PORT_DB = Number(process.env.PAY_DB_PORT ?? 54321);

// ───────────────────────── centinelas ─────────────────────────
const SENTINELS = {
  'PAN (continuo)': { value: '4111111111111111', pattern: /(?<![0-9A-Za-z-])4111111111111111(?![0-9A-Za-z-])/g },
  'PAN (con espacios)': { value: '4111 1111 1111 1111', pattern: /4111[ ]1111[ ]1111[ ]1111/g },
  'PAN (con guiones)': { value: '4111-1111-1111-1111', pattern: /4111-1111-1111-1111/g },
  'PAN (codificado en URL)': { value: '4111%201111%201111%201111', pattern: /4111(?:%20|\+)1111(?:%20|\+)1111(?:%20|\+)1111/gi },
  CVV: { value: '0731', pattern: /(?<![0-9A-Za-z-])0731(?![0-9A-Za-z-])/g },
  Documento: { value: 'CI-7654321-SCAN', pattern: /CI-7654321-SCAN/g },
  Nombre: { value: 'Sentinela Pagadora Nandu', pattern: /Sentinela(?:%20|\+| )Pagadora(?:%20|\+| )Nandu/gi },
};
const PAN = SENTINELS['PAN (continuo)'].value;
const PAN_SPACED = SENTINELS['PAN (con espacios)'].value;
const PAN_DASHED = SENTINELS['PAN (con guiones)'].value;
const PAN_URL = SENTINELS['PAN (codificado en URL)'].value;
const CVV = SENTINELS.CVV.value;
const DOC = SENTINELS.Documento.value;
const NAME = SENTINELS.Nombre.value;

/** Cuántas veces aparece cada centinela en `text`. */
function scan(text) {
  const hits = {};
  for (const [label, { pattern }] of Object.entries(SENTINELS)) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches?.length) hits[label] = matches.length;
  }
  return hits;
}

// ───────────────────────── infraestructura ─────────────────────────
const freePort = () =>
  new Promise((ok, fail) => {
    const s = netServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOCK_SECRET = 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==';

/** Receptor OTLP local: guarda los bytes EXACTOS que los servicios exportan como trazas. */
async function startTraceSink() {
  const chunks = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      chunks.push(Buffer.concat(parts));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/x-protobuf');
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, text: () => Buffer.concat(chunks).toString('latin1'), bytes: () => chunks.reduce((n, c) => n + c.length, 0), close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}

const SERVICES = [
  {
    name: 'pay-qr',
    role: 'pay_qr',
    password: 'dev_only_qr',
    port: 3104,
    sql: ['services/pay-qr/sql/ddl.sql'],
    env: { QR_ACCOUNT_GUID: 'e2e.sandbox.guid' },
  },
  {
    name: 'pay-connectors',
    role: 'pay_connectors',
    password: 'dev_only_connectors',
    port: 3103,
    sql: ['services/pay-connectors/sql/ddl.sql'],
    env: { PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: MOCK_SECRET, POLLER_INTERVAL_MS: '0', HEALTH_INTERVAL_MS: '0', RECONCILE_INTERVAL_MS: '0', MOCK_PUMP_INTERVAL_MS: '0' },
  },
  {
    name: 'pay-mockbank',
    role: 'pay_mockbank',
    password: 'dev_only_mockbank',
    port: 3112,
    sql: ['services/pay-mockbank/sql/001_mockbank.sql'],
    env: { MOCKBANK_WEBHOOK_SECRET: MOCK_SECRET, MOCKBANK_DELIVERY_INTERVAL_MS: '0' },
  },
];

async function startService(svc, traceUrl, extraEnv = {}) {
  const dist = join(ROOT, 'services', svc.name, 'dist/main.js');
  if (!existsSync(dist)) throw new Error(`falta ${dist}: compilá con "yarn build" en services/${svc.name}`);
  const dbName = svc.role;
  const schema = `scan_${process.pid}_${svc.role}`;
  const client = new pg.Client({ host: HOST, port: PORT_DB, user: svc.role, password: svc.password, database: dbName });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  for (const file of svc.sql) await client.query(readFileSync(join(ROOT, file), 'utf8'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    DB_HOST: HOST,
    DB_PORT: String(PORT_DB),
    DB_NAME: dbName,
    DB_USER: svc.role,
    DB_PASSWORD: svc.password,
    PGOPTIONS: `-c search_path=${schema}`,
    PORT: String(port),
    PAY_MODE: 'sandbox',
    LOG_LEVEL: 'trace',
    OTEL_EXPORTER_OTLP_ENDPOINT: traceUrl,
    OTEL_BSP_SCHEDULE_DELAY: '300',
    ...svc.env,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [dist], { cwd: join(ROOT, 'services', svc.name), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => (log += c.toString('utf8')));
  child.stderr.on('data', (c) => (log += c.toString('utf8')));
  const exited = new Promise((ok) => child.once('exit', ok));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) {
    try {
      if ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200) break;
    } catch {
      /* aún no escucha */
    }
    if (child.exitCode !== null) throw new Error(`${svc.name} terminó al arrancar:\n${log}`);
    await sleep(100);
  }
  return { svc, base, client, schema, child, exited, log: () => log };
}

// ───────────────────────── tráfico ─────────────────────────
const asConnectors = { 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test' };
const asPayments = { 'x-service-id': 'pay-payments', 'x-pay-mode': 'test' };
const asMockbank = { 'x-service-id': 'pay-mockbank' };
let n = 0;
const key = () => `scan-key-${process.pid}-${(n += 1)}-padding`;
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const intent = () => `pi_scan${String(Date.now()).slice(-6)}${String((n += 1)).padStart(4, '0')}`;

/** Cada elemento: [descripción, método, ruta, cabeceras, cuerpo(string|objeto|undefined)] */
function traffic(name) {
  const dirtyBody = { card_number: PAN, pan: PAN_SPACED, cvv: CVV, cvc: CVV, holder_name: NAME, payer_name: NAME, document: DOC, payer_document: DOC, nombre: NAME };
  const dirtyHeaders = { 'x-payer-document': DOC, 'x-forwarded-for': '10.1.2.3' };
  if (name === 'pay-connectors') {
    const goodCharge = (extra = {}) => ({ payment_intent_id: intent(), merchant_id: 'mc_clinicasantacruz1', amount_minor: 10000, currency: 'BOB', method: 'qr', expires_at: future(), ...extra });
    return [
      ['cobro válido con datos del pagador en campos extra', 'POST', '/charges', { ...asPayments, 'idempotency-key': key(), ...dirtyHeaders }, goodCharge(dirtyBody)],
      ['cobro con tarjeta: card_token es un PAN', 'POST', '/charges', { ...asPayments, 'idempotency-key': key() }, goodCharge({ method: 'card', card_token: PAN })],
      ['cobro con tarjeta: card_token PAN con espacios y descripción con nombre', 'POST', '/charges', { ...asPayments, 'idempotency-key': key() }, goodCharge({ method: 'card', card_token: PAN_SPACED, description: `Pago de ${NAME} ${DOC}` })],
      ['cobro válido con descripción con nombre y documento', 'POST', '/charges', { ...asPayments, 'idempotency-key': key() }, goodCharge({ description: `Pago de ${NAME} ${DOC}` })],
      ['cobro con el PAN en la clave de idempotencia', 'POST', '/charges', { ...asPayments, 'idempotency-key': `${PAN}-padding-padding` }, goodCharge()],
      ['cobro con JSON roto que contiene el PAN', 'POST', '/charges', { ...asPayments, 'idempotency-key': key(), 'content-type': 'application/json' }, `{"card_number":"${PAN}","cvv":"${CVV}",`],
      ['GET con el PAN en la ruta', 'GET', `/charges/${PAN}`, asPayments, undefined],
      ['GET con el PAN en la ruta (estado)', 'GET', `/charges/${PAN}/status?refresh=true&cvv=${CVV}`, asPayments, undefined],
      ['GET con el PAN con espacios en la ruta', 'GET', `/charges/${PAN_URL}`, asPayments, undefined],
      ['GET con PAN, CVV, documento y nombre en la query', 'GET', `/charges/ch_abcdefghij12?pan=${PAN}&cvv=${CVV}&doc=${DOC}&name=${encodeURIComponent(NAME)}`, asPayments, undefined],
      ['reembolso con datos sensibles en el cuerpo', 'POST', '/charges/ch_abcdefghij12/refunds', { ...asPayments, 'idempotency-key': key() }, { amount_minor: 100, ...dirtyBody }],
      ['transferencia con destino = PAN y datos del pagador', 'POST', '/transfers', { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test', 'idempotency-key': key() }, { business_ref: `po_scan${n}:payout`, attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: PAN, ...dirtyBody }],
      ['transferencia con el nombre como referencia', 'GET', `/transfers/${encodeURIComponent(NAME)}`, { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' }, undefined],
      ['extracto con el conector = PAN', 'GET', `/statements?connector=${PAN}&from=${PAN}&to=${DOC}`, { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' }, undefined],
      ['callback sin firma con PAN en el cuerpo', 'POST', '/callbacks/mock', { 'content-type': 'application/json' }, JSON.stringify({ id: 'evt_scan0001', reference: 'ch_abcdefghij12', status: 'captured', card_number: PAN, cvv: CVV, holder_name: NAME })],
      ['callback con firma de otro secreto y PAN', 'POST', '/callbacks/mock', { 'content-type': 'application/json', 'webhook-id': 'evt_scan0002', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' }, JSON.stringify({ id: 'evt_scan0002', card_number: PAN })],
      ['callback inexistente (conector = PAN)', 'POST', `/callbacks/${PAN}`, { 'content-type': 'application/json' }, JSON.stringify({ pan: PAN })],
      ['sin identidad de servicio, con PAN', 'POST', '/charges', { 'idempotency-key': key() }, goodCharge(dirtyBody)],
    ];
  }
  if (name === 'pay-qr') {
    const goodQr = (extra = {}) => ({ kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: 10000, payment_intent_id: intent(), expires_at: future(), ...extra });
    return [
      ['QR válido con datos del pagador en campos extra', 'POST', '/qr', { ...asConnectors, 'idempotency-key': key(), ...dirtyHeaders }, goodQr(dirtyBody)],
      ['QR con el intento de pago = PAN', 'POST', '/qr', { ...asConnectors, 'idempotency-key': key() }, goodQr({ payment_intent_id: PAN })],
      ['QR con el nombre del comercio = PAN', 'POST', '/qr', { ...asConnectors, 'idempotency-key': key() }, goodQr({ merchant_name: PAN })],
      ['QR con el PAN en la clave de idempotencia', 'POST', '/qr', { ...asConnectors, 'idempotency-key': `${PAN}-padding-padding` }, goodQr()],
      ['QR con JSON roto que contiene el PAN', 'POST', '/qr', { ...asConnectors, 'idempotency-key': key(), 'content-type': 'application/json' }, `{"pan":"${PAN}","cvv":"${CVV}",`],
      ['decodificar un payload que es un PAN', 'POST', '/qr/decode', asConnectors, { payload: PAN }],
      ['decodificar un payload con el PAN y el nombre', 'POST', '/qr/decode', asConnectors, { payload: `000201${PAN}${NAME}6304ABCD` }],
      ['GET con el PAN en la ruta', 'GET', `/qr/${PAN}`, asConnectors, undefined],
      ['GET imagen con el PAN en la ruta y la query', 'GET', `/qr/${PAN}/image?format=${PAN}&cvv=${CVV}`, asConnectors, undefined],
      ['GET por referencia = PAN', 'GET', `/qr-references/${PAN}`, asConnectors, undefined],
      ['GET con el nombre y el documento en la query', 'GET', `/qr/qr_abcdefghij12?name=${encodeURIComponent(NAME)}&doc=${DOC}`, asConnectors, undefined],
      ['anular con el PAN en la ruta', 'POST', `/qr/${PAN}/cancel`, { ...asConnectors, 'idempotency-key': key() }, {}],
      ['sin identidad de servicio, con PAN', 'POST', '/qr', { 'idempotency-key': key() }, goodQr(dirtyBody)],
    ];
  }
  const goodCharge = (extra = {}) => ({ reference: `ch_scan${String(Date.now()).slice(-6)}${String((n += 1)).padStart(4, '0')}`, amount_minor: 10000, currency: 'BOB', method: 'qr', expires_at: future(), ...extra });
  return [
    ['cobro válido con datos del pagador en campos extra', 'POST', '/sandbox/charges', { ...asConnectors, ...dirtyHeaders }, goodCharge(dirtyBody)],
    ['cobro con referencia = PAN', 'POST', '/sandbox/charges', asConnectors, goodCharge({ reference: PAN })],
    ['autorización de tarjeta: card_token = PAN', 'POST', '/sandbox/card-authorizations', asConnectors, { reference: goodCharge().reference, amount_minor: 10000, card_token: PAN }],
    ['autorización de tarjeta: card_token = PAN con espacios y CVV', 'POST', '/sandbox/card-authorizations', asConnectors, { reference: goodCharge().reference, amount_minor: 10000, card_token: PAN_SPACED, cvv: CVV }],
    ['autorización de tarjeta: token con PAN pegado', 'POST', '/sandbox/card-authorizations', asConnectors, { reference: goodCharge().reference, amount_minor: 10000, card_token: `tok_${PAN}` }],
    ['autorización de tarjeta válida (tok_) con titular y documento extra', 'POST', '/sandbox/card-authorizations', asConnectors, { reference: goodCharge().reference, amount_minor: 10000, card_token: 'tok_prueba0001', holder_name: NAME, document: DOC }],
    ['autorización de tarjeta válida (tok_)', 'POST', '/sandbox/card-authorizations', asConnectors, { reference: goodCharge().reference, amount_minor: 10000, card_token: 'tok_prueba0002' }],
    ['GET con el PAN en la ruta', 'GET', `/sandbox/charges/${PAN}`, asConnectors, undefined],
    ['GET autorización con el PAN en la ruta', 'GET', `/sandbox/card-authorizations/${PAN}?cvv=${CVV}`, asConnectors, undefined],
    ['capturar con el PAN en la ruta', 'POST', `/sandbox/card-authorizations/${PAN}/capture`, asConnectors, { amount_minor: 100, cvv: CVV }],
    ['reembolso con datos sensibles', 'POST', '/sandbox/refunds', asConnectors, { reference: PAN, charge_reference: NAME, amount_minor: 100, document: DOC }],
    ['transferencia con destino = PAN', 'POST', '/sandbox/transfers', asConnectors, { reference: 'po_scan:payout:1', amount_minor: 250000, destination_ref: PAN }],
    ['depósito del pagador con la referencia = PAN', 'POST', '/sandbox/payer/transfer-in', asMockbank, { reference: PAN, amount_minor: 100 }],
    ['pagador: QR = PAN', 'POST', '/sandbox/payer/pay', asMockbank, { qr_payload: PAN }],
    ['pagador: QR con el nombre y el documento', 'POST', '/sandbox/payer/pay', asMockbank, { qr_payload: `000201${NAME}${DOC}6304ABCD` }],
    ['extracto con fechas = PAN y formato = nombre', 'GET', `/sandbox/statement?from=${PAN}&to=${DOC}&format=${encodeURIComponent(NAME)}`, asConnectors, undefined],
    ['línea inyectada con descripción = nombre', 'POST', '/sandbox/admin/statement-lines', asMockbank, { direction: 'credit', amount_minor: 100, booked_at: new Date().toISOString(), description: NAME.slice(0, 20) }],
    ['sin identidad de servicio, con PAN', 'POST', '/sandbox/charges', {}, goodCharge(dirtyBody)],
  ];
}

async function send([desc, method, path, headers, body]) {
  const init = { method, headers: { connection: 'close', ...headers }, signal: AbortSignal.timeout(10_000) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') init.headers['content-type'] = 'application/json';
  }
  return { desc, method, path, init };
}

/** Texto de toda columna de texto/json de las tablas del esquema (para buscar centinelas en lo que quedó guardado). */
async function dumpSchema(client, schema) {
  const cols = (await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND data_type IN ('text','character varying','json','jsonb','bytea','ARRAY','USER-DEFINED')`, [schema])).rows;
  const byTable = new Map();
  for (const c of cols) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  const out = {};
  for (const [table, columns] of byTable) {
    const rows = (await client.query(`SELECT ${columns.map((c) => `"${c}"::text AS "${c}"`).join(', ')} FROM ${schema}."${table}"`)).rows;
    out[table] = rows.map((r) => Object.values(r).join(' | ')).join('\n');
  }
  return out;
}

// ───────────────────────── ejecución ─────────────────────────
const failures = [];
const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

// Control positivo: el escáner tiene que ver lo que está plantado.
{
  const planted = `línea de log con ${PAN} y ${CVV} y ${DOC}, y ${PAN_SPACED}, ${PAN_DASHED}, ${NAME}, ${PAN_URL}`;
  const hits = scan(planted);
  const missing = Object.keys(SENTINELS).filter((l) => !hits[l]);
  say(`CONTROL POSITIVO: el escáner encuentra ${Object.keys(hits).length}/${Object.keys(SENTINELS).length} centinelas plantados${missing.length ? ` — NO ve: ${missing.join(', ')}` : ''}`);
  if (missing.length) {
    failures.push('el escáner no detecta sus propios centinelas');
  }
  const clean = scan('request_id 4d58b5ea-4111-4111-1111-111111111111 ts 1793146539719 amount 10731 code 07310');
  say(`CONTROL NEGATIVO: texto limpio con números parecidos ⇒ ${Object.keys(clean).length} falsos positivos`);
  if (Object.keys(clean).length) failures.push('el escáner da falsos positivos');
}

const sink = await startTraceSink();
const results = [];
const running_ = [];
let qrBase;
for (const svc of SERVICES) {
  say('');
  say(`══ ${svc.name} (rol ${svc.role}, esquema descartable) ══`);
  // pay-qr real para los cobros por QR de pay-connectors y para que el pagador de pay-mockbank decodifique de verdad.
  const running = await startService(svc, sink.url, qrBase ? { PAY_QR_URL: qrBase } : {});
  if (svc.name === 'pay-qr') qrBase = running.base;
  const responses = [];
  let statuses = {};
  for (const call of traffic(svc.name)) {
    const { desc, method, path, init } = await send(call);
    try {
      const response = await fetch(`${running.base}${path}`, init);
      const text = await response.text();
      const headerText = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      responses.push({ desc, status: response.status, text: `${response.status}\n${headerText}\n${text}` });
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    } catch (error) {
      responses.push({ desc, status: 0, text: `ERROR de red: ${String(error)}` });
      statuses[0] = (statuses[0] ?? 0) + 1;
    }
  }
  for (const r of responses) if (r.status >= 500 || r.status === 0) say(`     ⚠ HTTP ${r.status} en «${r.desc}»`);
  say(`peticiones: ${responses.length} (estados: ${Object.entries(statuses).map(([s, c]) => `${s}×${c}`).join(' ')})`);
  await sleep(1200); // deja que el exportador de trazas vacíe su cola
  const db = await dumpSchema(running.client, running.schema);
  const eventsText = [db.outbox_events, db.idempotency_keys].filter(Boolean).join('\n');
  running_.push(running);
  const logText = running.log();
  const channels = {
    'logs (stdout/stderr)': logText,
    'errores (cuerpo y cabeceras de TODAS las respuestas)': responses.map((r) => r.text).join('\n'),
    'eventos y claves de idempotencia (outbox_events, idempotency_keys)': eventsText,
    'base propia (toda columna de texto/json de todas las tablas)': Object.values(db).join('\n'),
  };
  say(`logs capturados: ${logText.length} bytes · filas guardadas en: ${Object.entries(db).map(([t, v]) => `${t}=${v ? v.split('\n').length : 0}`).join(' ')}`);
  for (const [channel, text] of Object.entries(channels)) {
    const hits = scan(text);
    const clean = Object.keys(hits).length === 0;
    say(`  ${clean ? 'PASS' : 'FALLA'}  ${channel}${clean ? ': 0 centinelas' : `: ${JSON.stringify(hits)}`}`);
    if (!clean) failures.push(`${svc.name} · ${channel}: ${JSON.stringify(hits)}`);
    results.push({ service: svc.name, channel, hits });
  }
  // Para depurar un hallazgo: qué petición lo provocó.
  for (const r of responses) {
    const hits = scan(r.text);
    if (Object.keys(hits).length) say(`     ↳ respuesta con centinela en «${r.desc}» (HTTP ${r.status}): ${JSON.stringify(hits)}`);
  }
}

// pay-qr siguió vivo mientras los otros dos lo usaban: se cierran todos y se mira OTRA VEZ lo último que dejaron (logs y base completos), ya con todo el tráfico.
say('');
say('══ cierre: logs y bases FINALES de los tres servicios (incluye lo que pay-qr recibió de los otros dos) ══');
await sleep(1200);
const finals = [];
for (const r of running_) {
  const dbFinal = await dumpSchema(r.client, r.schema);
  r.child.kill('SIGTERM');
  await Promise.race([r.exited, sleep(10_000)]);
  const channels = { 'logs finales': r.log(), 'base final': Object.values(dbFinal).join('\n') };
  for (const [channel, text] of Object.entries(channels)) {
    const hits = scan(text);
    const clean = Object.keys(hits).length === 0;
    say(`  ${clean ? 'PASS' : 'FALLA'}  ${r.svc.name} · ${channel}: ${clean ? '0 centinelas' : JSON.stringify(hits)}`);
    if (!clean) failures.push(`${r.svc.name} · ${channel}: ${JSON.stringify(hits)}`);
  }
  finals.push(r);
}
for (const r of finals) {
  await r.client.query(`DROP SCHEMA ${r.schema} CASCADE`);
  await r.client.end();
}

// Trazas: se juntan las de los tres servicios (un solo receptor).
await sleep(500);
const traces = sink.text();
const traceHits = scan(traces);
const traceClean = Object.keys(traceHits).length === 0;
say('');
say(`══ trazas OpenTelemetry (OTLP) de los tres servicios: ${sink.bytes()} bytes exportados ══`);
say(`  ${traceClean ? 'PASS' : 'FALLA'}  trazas: ${traceClean ? '0 centinelas' : JSON.stringify(traceHits)}`);
if (sink.bytes() === 0) {
  failures.push('no se exportó ninguna traza: el canal de trazas no se pudo comprobar');
  say('  FALLA  no se exportó ninguna traza (no se comprobó nada)');
}
if (!traceClean) {
  failures.push(`trazas: ${JSON.stringify(traceHits)}`);
  // Para depurar: el contexto (solo caracteres imprimibles) de cada hallazgo, para ver QUÉ atributo del span lo trae.
  for (const [label, { pattern }] of Object.entries(SENTINELS)) {
    for (const m of [...traces.matchAll(new RegExp(pattern.source, pattern.flags))].slice(0, 3)) {
      const around = traces.slice(Math.max(0, m.index - 90), m.index + 40).replace(/[^\x20-\x7e]+/g, ' · ');
      say(`     ↳ ${label}: …${around}…`);
    }
  }
}
await sink.close();

say('');
say(failures.length === 0 ? 'RESULTADO: PASS — ningún centinela (PAN, CVV, documento, nombre) en logs, trazas, eventos, errores ni base.' : `RESULTADO: FALLA — ${failures.length} hallazgo(s):\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
