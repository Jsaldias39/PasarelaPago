#!/usr/bin/env node
// Gates de la ola 3 de P5 (docs/plan/PLAN-MAESTRO.md §7) para pay-merchants, pay-risk y pay-schedules.
// Reproducible: `node scripts/p5-gates.mjs <separation|sensitive|faults|drift|all>`. Cada subcomando imprime líneas PASS/FAIL y termina en 1 si hubo FAIL.
//
// Qué toca y qué NO toca:
//  - Crea bases TEMPORALES `p5gate_<svc>_<id>` en el Postgres del Compose (dueño: el rol pay_<svc> del Compose, sin permiso para nadie más) y las
//    borra al terminar. NO toca las bases `pay_<svc>` del Compose: las usa el arnés de P1.
//  - Levanta un NATS PRIVADO (docker, JetStream) en un puerto libre y lo borra al terminar: no publica nada en los streams `PAY_*` compartidos.
//  - Arranca `node dist/main.js` de cada servicio (hay que haber corrido `yarn build`) con SU rol de base, y los apaga por PID propio.
//  - Todos los datos son CENTINELAS sintéticos; ninguna persona real.
import { spawn, spawnSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { host: '127.0.0.1', port: 54321, user: 'postgres', password: process.env.PAY_E2E_ADMIN_PASSWORD ?? 'pay', database: 'postgres' };
const JAEGER_API = 'http://127.0.0.1:54686';
const JAEGER_OTLP = 'http://127.0.0.1:54318';
const WATCHMAN = 'http://127.0.0.1:54084';
const NATS_IMAGE = 'mirror.gcr.io/library/nats:2.10-alpine';
const SERVICES = ['pay-merchants', 'pay-risk', 'pay-schedules'];
const ALL_DBS = ['edge', 'payments', 'connectors', 'qr', 'ledger', 'settlement', 'merchants', 'risk', 'schedules', 'webhooks', 'vault', 'mockbank'].map((s) => `pay_${s}`);

let failures = 0;
const out = (line) => process.stdout.write(`${line}\n`);
const check = (ok, text) => {
  if (!ok) failures += 1;
  out(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => randomBytes(4).toString('hex');

async function until(probe, timeoutMs, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Promise.resolve(probe()).catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}

async function freePort() {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

// ───────────────────────── infraestructura temporal ─────────────────────────

async function admin() {
  const c = new pg.Client(ADMIN);
  await c.connect();
  return c;
}

/** NATS privado con JetStream en un contenedor propio. Devuelve su URL y cómo pararlo / reiniciarlo. */
async function startPrivateNats() {
  const port = await freePort();
  const name = `p5gate-nats-${rand()}`;
  const run = () => spawnSync('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:4222`, NATS_IMAGE, '-js'], { encoding: 'utf8' });
  const first = run();
  if (first.status !== 0) throw new Error(`No se pudo arrancar el NATS privado: ${first.stderr}`);
  const { connect } = await import('nats');
  const ready = await until(async () => {
    const nc = await connect({ servers: `nats://127.0.0.1:${port}`, timeout: 1000 });
    await nc.close();
    return true;
  }, 30_000);
  if (!ready) throw new Error('El NATS privado no quedó listo');
  return {
    url: `nats://127.0.0.1:${port}`,
    port,
    stop: () => spawnSync('docker', ['stop', '-t', '1', name]),
    start: () => spawnSync('docker', ['start', name]),
    remove: () => spawnSync('docker', ['rm', '-f', name]),
    async streamMessages(stream) {
      const nc = await connect({ servers: `nats://127.0.0.1:${port}` });
      try {
        const jsm = await nc.jetstreamManager();
        const info = await jsm.streams.info(stream).catch(() => undefined);
        return info ? Number(info.state.messages) : 0;
      } finally {
        await nc.close();
      }
    },
    async streamPayloads(stream) {
      const nc = await connect({ servers: `nats://127.0.0.1:${port}` });
      try {
        const jsm = await nc.jetstreamManager();
        const info = await jsm.streams.info(stream).catch(() => undefined);
        if (!info || info.state.messages === 0) return [];
        const texts = [];
        for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq += 1) {
          const msg = await jsm.streams.getMessage(stream, { seq }).catch(() => undefined);
          if (msg) texts.push(new TextDecoder().decode(msg.data));
        }
        return texts;
      } finally {
        await nc.close();
      }
    },
  };
}

/** El DDL que sale del modelo y se vendoriza (`node scripts/p5-vendor-model-sql.mjs`); trae también las tablas técnicas. */
function ddlFiles(svc) {
  return [join(ROOT, 'services', svc, 'sql', 'ddl.sql')];
}

/** Lo que aplica HOY el arnés e2e de P1 (e2e/lib/infra.ts `ddlFiles`): las dos librerías + todo `sql/*.sql` del servicio, en orden alfabético. */
function e2eHarnessDdlFiles(svc) {
  const sqlOf = (dir) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
  return [...['outbox', 'idempotency'].flatMap((p) => sqlOf(join(ROOT, 'contracts/packages', p, 'sql'))), ...sqlOf(join(ROOT, 'services', svc, 'sql'))];
}

const roleOf = (svc) => `pay_${svc.replace('pay-', '')}`;
const passwordOf = (svc) => `dev_only_${svc.replace('pay-', '')}`;

/** Base temporal: dueño = rol del servicio del Compose; PUBLIC sin permisos (igual que platform/postgres/init-databases.sh). DDL aplicado CON ESE ROL. */
async function createTempDatabase(svc) {
  const db = `p5gate_${svc.replace('pay-', '')}_${rand()}`;
  const role = roleOf(svc);
  const a = await admin();
  try {
    await a.query(`CREATE DATABASE ${db} OWNER ${role}`);
    await a.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await a.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  } finally {
    await a.end();
  }
  const owner = new pg.Client({ host: ADMIN.host, port: ADMIN.port, database: db, user: role, password: passwordOf(svc) });
  await owner.connect();
  try {
    for (const file of ddlFiles(svc)) await owner.query(readFileSync(file, 'utf8'));
  } finally {
    await owner.end();
  }
  return db;
}

async function dropTempDatabase(db) {
  const a = await admin();
  try {
    await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  } finally {
    await a.end();
  }
}

/** Cliente a la base temporal con el rol DEL SERVICIO (lo que el servicio puede ver). */
async function serviceClient(svc, db) {
  const c = new pg.Client({ host: ADMIN.host, port: ADMIN.port, database: db, user: roleOf(svc), password: passwordOf(svc) });
  await c.connect();
  return c;
}

// ───────────────────────── arranque de servicios ─────────────────────────

const JWT = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    token(roles) {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: 'p5gate-issuer', aud: 'pay-merchants', sub: 'operador_gate_01', roles, mode: 'sandbox', iat: now, exp: now + 3600 })}`;
      return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
    },
  };
})();

/** Arranca un servicio contra una base temporal. `extraEnv` pisa lo común. Devuelve un objeto con url, log, db y `stop()`. */
async function boot(svc, { natsUrl, extraEnv = {}, trace = false, readyTimeoutMs = 60_000 } = {}) {
  const db = await createTempDatabase(svc);
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), `p5gate-${svc}-`));
  const logFile = join(runDir, `${svc}.log`);
  const traceName = `p5gate-${svc}-${rand()}`;
  const env = {
    PORT: String(port),
    LOG_LEVEL: 'info',
    DB_HOST: ADMIN.host,
    DB_PORT: String(ADMIN.port),
    DB_NAME: db,
    DB_USER: roleOf(svc),
    DB_PASSWORD: passwordOf(svc),
    PAY_MODE: 'sandbox',
    ...(natsUrl ? { NATS_URL: natsUrl } : {}),
    ...(trace ? { OTEL_EXPORTER_OTLP_ENDPOINT: JAEGER_OTLP, OTEL_SERVICE_NAME: traceName } : {}),
    ...extraEnv,
  };
  if (svc === 'pay-merchants') {
    mkdirSync(join(runDir, 'kyc'));
    Object.assign(env, { KYC_STORE_DIR: join(runDir, 'kyc'), OPERATOR_TOKEN_PUBLIC_KEY: JWT.publicPem.replace(/\n/g, '\\n'), OPERATOR_TOKEN_ISSUER: 'p5gate-issuer', OPERATOR_TOKEN_AUDIENCE: 'pay-merchants', ...extraEnv });
  }
  if (svc === 'pay-risk') {
    Object.assign(env, { WATCHMAN_URL: WATCHMAN, SANCTIONS_DENY_SCORE: '0.80', SANCTIONS_REVIEW_SCORE: '0.60', PAYER_HASH_KEY: `p5gate-${randomBytes(16).toString('hex')}`, ...extraEnv });
  }
  if (svc === 'pay-schedules') {
    Object.assign(env, { LEDGER_URL: 'http://127.0.0.1:1', RETRY_DELAYS_SECONDS: '1,1', RUN_INTERVAL_SECONDS: '1', ...extraEnv });
  }
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: join(ROOT, 'services', svc), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let exited;
  const exitedP = new Promise((r) => child.once('exit', (code, signal) => ((exited = { code, signal }), r())));
  const url = `http://127.0.0.1:${port}`;
  const ready = await until(async () => (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) })).status === 200, readyTimeoutMs);
  const handle = {
    svc,
    url,
    db,
    logFile,
    runDir,
    traceName,
    pid: child.pid,
    ready,
    exited: () => exited,
    log: () => readFileSync(logFile, 'utf8'),
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([exitedP, sleep(10_000)]);
        if (!exited) {
          child.kill('SIGKILL');
          await exitedP;
        }
      }
    },
    async dispose() {
      await this.stop();
      await dropTempDatabase(db);
      rmSync(runDir, { recursive: true, force: true });
    },
  };
  return handle;
}

async function http(method, url, { headers = {}, json, body } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
  } else if (body !== undefined) init.body = body;
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, text, json: parsed };
}

// ───────────────────────── 1 · SEPARACIÓN ─────────────────────────

async function separation() {
  out('# Gate: SEPARACIÓN — cada servicio arranca y trabaja con un rol de base sin permisos sobre las demás');
  const nats = await startPrivateNats();
  try {
    for (const svc of SERVICES) {
      const role = roleOf(svc);
      out(`\n## ${svc} (rol ${role}, contraseña dev_only_${svc.replace('pay-', '')} del Compose)`);
      const s = await boot(svc, { natsUrl: nats.url });
      try {
        check(s.ready, `${svc} arrancó y GET /health/ready == 200 con el rol ${role} (base temporal ${s.db}, dueño ${role})`);
        // Lo que el servicio ve: el rol del que depende.
        const own = await serviceClient(svc, s.db);
        try {
          const r = await own.query(`SELECT current_user AS usuario, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superusuario, (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS crea_bases, (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS crea_roles`);
          out(`     rol efectivo: ${JSON.stringify(r.rows[0])}`);
          check(r.rows[0].superusuario === false && r.rows[0].crea_bases === false && r.rows[0].crea_roles === false, `${role} no es superusuario ni puede crear bases ni roles`);
        } finally {
          await own.end();
        }
        // Sesiones reales del proceso del servicio (vistas por el administrador).
        const a = await admin();
        try {
          const sessions = await a.query(`SELECT usename, datname, count(*)::int AS sesiones FROM pg_stat_activity WHERE datname = $1 GROUP BY 1, 2`, [s.db]);
          out(`     sesiones del proceso en pg_stat_activity: ${JSON.stringify(sessions.rows)}`);
          check(sessions.rows.length > 0 && sessions.rows.every((x) => x.usename === role), `todas las sesiones abiertas por ${svc} usan el rol ${role}`);
        } finally {
          await a.end();
        }
        // Con las MISMAS credenciales del servicio, ninguna otra base.
        const others = [...ALL_DBS.filter((d) => d !== role), 'postgres', 'pay_test'];
        let denied = 0;
        const unexpected = [];
        for (const target of others) {
          const c = new pg.Client({ host: ADMIN.host, port: ADMIN.port, database: target, user: role, password: passwordOf(svc) });
          try {
            await c.connect();
            unexpected.push(`${target}: ENTRÓ`);
            await c.end();
          } catch (error) {
            if (/permission denied for database/.test(String(error.message))) denied += 1;
            else unexpected.push(`${target}: ${error.message}`);
          }
        }
        out(`     ${role} contra ${others.length} bases ajenas: ${denied} × «permission denied for database»${unexpected.length ? `; inesperado: ${unexpected.join(' | ')}` : ''}`);
        check(denied === others.length && unexpected.length === 0, `${role} NO entra a ninguna de las ${others.length} bases ajenas (11 servicios + postgres + pay_test)`);
        // Otro servicio no entra a la base temporal de éste.
        const intruder = SERVICES.find((x) => x !== svc);
        const c = new pg.Client({ host: ADMIN.host, port: ADMIN.port, database: s.db, user: roleOf(intruder), password: passwordOf(intruder) });
        let blocked = false;
        try {
          await c.connect();
          await c.end();
        } catch (error) {
          blocked = /permission denied for database/.test(String(error.message));
        }
        check(blocked, `el rol de ${intruder} tampoco entra a la base de ${svc} (${s.db})`);
      } finally {
        await s.dispose();
      }
    }
  } finally {
    nats.remove();
  }
  out('\n## matriz completa del Compose (platform/scripts/check-db-separation.sh, solo lectura)');
  const matrix = spawnSync('bash', [join(ROOT, 'platform/scripts/check-db-separation.sh')], { encoding: 'utf8' });
  out(matrix.stdout.trim());
  check(matrix.status === 0, 'check-db-separation.sh: 12 roles × (12 bases + postgres + pay_test), sin fallas');
}

// ───────────────────────── 2 · DATOS SENSIBLES ─────────────────────────

const PAN = '4111111111111111';
const BRAND = /^(4\d{12}(\d{3}(\d{3})?)?|5[1-5]\d{14}|2(2[2-9]\d|[3-6]\d\d|7[01]\d|720)\d{12}|3[47]\d{13}|6011\d{12}|65\d{14}|35\d{14})$/;
const luhn = (digits) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/** Números de tarjeta (marca + Luhn + largo) y rótulos de CVV dentro de un texto. */
function cardFindings(text) {
  const found = [];
  for (const match of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && BRAND.test(digits) && luhn(digits)) found.push(`PAN ${digits.slice(0, 6)}…${digits.slice(-4)}`);
  }
  for (const match of text.matchAll(/["']?(cvv2?|cvc2?|cid|security_?code|card_?number|pan)["']?\s*[:=]\s*["']?\d{3,19}/gi)) found.push(`rótulo ${match[0].slice(0, 40)}`);
  return found;
}

async function jaegerText(service) {
  await sleep(0);
  const ok = await until(async () => {
    const res = await fetch(`${JAEGER_API}/api/traces?service=${encodeURIComponent(service)}&limit=500&lookback=1h`);
    const body = await res.json();
    return Array.isArray(body.data) && body.data.length > 0;
  }, 25_000, 1000);
  if (!ok) return { text: '', spans: 0 };
  const body = await (await fetch(`${JAEGER_API}/api/traces?service=${encodeURIComponent(service)}&limit=500&lookback=1h`)).json();
  return { text: JSON.stringify(body), spans: body.data.reduce((n, t) => n + t.spans.length, 0) };
}

/**
 * `sources`: { nombre: texto }. `sentinels`: { rótulo: valor }. `allowed`: { fuente: [rótulos permitidos] }.
 * Imprime una línea por (fuente × centinela) con el recuento, y una por fuente con los hallazgos de tarjeta.
 */
function grepSources(sources, sentinels, allowed = {}) {
  for (const [source, text] of Object.entries(sources)) {
    const bad = [];
    const permitted = [];
    const snippets = [];
    for (const [label, value] of Object.entries(sentinels)) {
      const count = text.split(value).length - 1;
      if (count === 0) continue;
      if ((allowed[source] ?? []).includes(label)) permitted.push(`${label}×${count}`);
      else {
        bad.push(`${label}×${count}`);
        const at = text.indexOf(value);
        snippets.push(`${label}: …${text.slice(Math.max(0, at - 70), at + value.length + 20).replace(/\s+/g, ' ')}…`);
      }
    }
    const cards = cardFindings(text);
    out(`     ${source.padEnd(34)} ${String(text.length).padStart(8)} bytes · centinelas: ${bad.length ? `HALLADOS ${bad.join(', ')}` : '0'}${permitted.length ? ` (permitidos por contrato: ${permitted.join(', ')})` : ''} · PAN/CVV: ${cards.length ? cards.join(', ') : '0'}`);
    for (const snippet of snippets) out(`        ↳ ${snippet}`);
    check(bad.length === 0 && cards.length === 0, `${source}: sin centinelas prohibidos ni PAN/CVV`);
  }
}

async function sensitive() {
  out('# Gate: DATOS SENSIBLES — sin PAN, CVV, documento ni nombre (razón social, nombre del pagador) en logs, trazas, eventos ni errores');
  out('# Método: se envían datos CENTINELA sintéticos a cada servicio real (HTTP), se provocan errores, y se busca cada centinela en: el log del proceso,');
  out('# las trazas OTel (Jaeger), el outbox + los mensajes publicados en JetStream, y los cuerpos de error devueltos. Además un detector de PAN (marca + Luhn) y de rótulos CVV.');
  const nats = await startPrivateNats();
  try {
    const only = process.env.P5_GATE_ONLY;
    if (!only || only === 'pay-merchants') await sensitiveMerchants(nats);
    if (!only || only === 'pay-risk') await sensitiveRisk(nats);
    if (!only || only === 'pay-schedules') await sensitiveSchedules(nats);
  } finally {
    nats.remove();
  }
}

async function outboxText(svc, db) {
  const c = await serviceClient(svc, db);
  try {
    const exists = (await c.query(`SELECT to_regclass('outbox_events') AS t`)).rows[0].t;
    if (!exists) return []; // pay-risk no emite eventos: su DDL no trae outbox
    const { rows } = await c.query('SELECT type, envelope::text AS e FROM outbox_events ORDER BY seq');
    return rows;
  } finally {
    await c.end();
  }
}

async function sensitiveMerchants(nats) {
  const SENT = { razon_social: 'RAZON-CENTINELA-9F2K SRL', fantasia: 'FANTASIA-CENTINELA-7Q1', nit: '9988776655', documento: 'DOCUMENTO-CENTINELA-5X8', pan: PAN };
  out('\n## pay-merchants');
  const s = await boot('pay-merchants', { natsUrl: nats.url, trace: true });
  const errors = [];
  try {
    check(s.ready, 'pay-merchants arrancó (rol pay_merchants, NATS privado, OTel → Jaeger)');
    const bo = (roles = ['merchant_operator', 'kyc_reviewer']) => ({ 'x-service-id': 'pay-backoffice', authorization: `Bearer ${JWT.token(roles)}` });
    const created = await http('POST', `${s.url}/merchants`, { headers: { ...bo(), 'idempotency-key': `gate-${rand()}-0001` }, json: { display_name: SENT.fantasia, legal_name: SENT.razon_social, legal_type: 'srl', tax_id: SENT.nit } });
    out(`     alta de comercio: ${created.status}`);
    check(created.status === 201, 'POST /merchants con razón social, fantasía y NIT centinela ⇒ 201');
    const id = created.json?.id;
    const form = new FormData();
    form.set('kind', 'constitucion');
    form.set('file', new Blob([`%PDF-1.7\n% ${SENT.documento} ${SENT.pan}\n%%EOF\n`], { type: 'application/pdf' }), 'constitucion.pdf');
    const upload = await http('POST', `${s.url}/merchants/${id}/kyc/documents`, { headers: bo(), body: form });
    out(`     documento KYC: ${upload.status}`);
    check(upload.status === 201, 'POST /kyc/documents con contenido centinela (y un PAN de prueba dentro del archivo) ⇒ 201');
    // Errores provocados con los centinelas en los valores.
    const e1 = await http('POST', `${s.url}/merchants`, { headers: { ...bo(), 'idempotency-key': `gate-${rand()}-0002` }, json: { display_name: SENT.fantasia, legal_name: SENT.razon_social, legal_type: 'no-existe', tax_id: SENT.nit, cvv: '123', card_number: SENT.pan } });
    const e2 = await http('POST', `${s.url}/merchants`, { headers: { ...bo(), 'idempotency-key': `gate-${rand()}-0003` }, json: { display_name: SENT.fantasia, legal_name: SENT.razon_social, legal_type: 'srl', tax_id: SENT.nit } });
    const fake = new FormData();
    fake.set('kind', 'nit');
    fake.set('file', new Blob([`MZ\u0090 ${SENT.documento} ${SENT.pan}`], { type: 'application/pdf' }), 'nit.pdf');
    const e3 = await http('POST', `${s.url}/merchants/${id}/kyc/documents`, { headers: bo(), body: fake });
    const e4 = await http('GET', `${s.url}/merchants/mc_${SENT.nit}zzzz`, { headers: bo() });
    const e5 = await http('GET', `${s.url}/merchants/${id}`, { headers: { 'x-service-id': 'pay-backoffice' } });
    const e6 = await http('GET', `${s.url}/${SENT.razon_social.replace(/ /g, '%20')}/${SENT.pan}`, { headers: bo() });
    for (const [name, r] of [['campos inválidos + cvv + card_number', e1], ['NIT repetido', e2], ['archivo que no es PDF', e3], ['comercio inexistente', e4], ['sin credencial', e5], ['ruta inexistente con centinelas', e6]]) {
      out(`     error provocado «${name}»: ${r.status} ${r.text.slice(0, 110).replace(/\s+/g, ' ')}`);
      errors.push(r.text);
    }
    check([e1, e2, e3, e4, e5, e6].every((r) => r.status >= 400 && r.status < 500), 'los seis errores provocados responden 4xx (ninguno 5xx)');
    await sleep(1500);
    const rows = await outboxText('pay-merchants', s.db);
    const published = await nats.streamPayloads('PAY_MERCHANTS');
    out(`     eventos: ${rows.length} en el outbox (${[...new Set(rows.map((r) => r.type))].join(', ')}), ${published.length} publicados en JetStream`);
    await s.stop();
    await sleep(500);
    const traces = await jaegerText(s.traceName);
    out(`     trazas: ${traces.spans} spans en Jaeger para el servicio ${s.traceName}`);
    check(traces.spans > 0, 'Jaeger recibió spans del servicio (si no, el grep de trazas no demostraría nada)');
    const eventsByType = (types) => rows.filter((r) => types.includes(r.type)).map((r) => r.e).join('\n');
    out('   fuentes (la razón social solo puede aparecer en merchant.created / merchant.activated, D-33):');
    grepSources(
      {
        'logs del proceso': s.log(),
        'trazas (Jaeger)': traces.text,
        'eventos del outbox: merchant.created': eventsByType(['merchant.created']),
        'eventos del outbox: los demás': rows.filter((r) => r.type !== 'merchant.created' && r.type !== 'merchant.activated').map((r) => r.e).join('\n'),
        'mensajes publicados en JetStream': published.join('\n'),
        'cuerpos de error devueltos': errors.join('\n'),
      },
      SENT,
      { 'eventos del outbox: merchant.created': ['razon_social'], 'mensajes publicados en JetStream': ['razon_social'] },
    );
    const createdEvent = rows.find((r) => r.type === 'merchant.created');
    check(createdEvent !== undefined && createdEvent.e.includes(SENT.razon_social), 'merchant.created lleva la razón social (D-33): es el único dato nominal permitido en eventos');
    check(!published.join('\n').includes(SENT.nit) && !published.join('\n').includes(SENT.fantasia), 'lo publicado en JetStream no lleva NIT ni nombre de fantasía');
  } finally {
    await s.dispose();
  }
}

async function sensitiveRisk(nats) {
  const SENT = { razon_social_comercio: 'RAZON-CENTINELA-R1 SRL', nombre_pagador: 'NOMBRE-PAGADOR-CENTINELA-P1', huella_pan: PAN };
  out('\n## pay-risk (cribado contra el Watchman REAL del Compose, listas estáticas de 2019 solo sandbox)');
  const s = await boot('pay-risk', { natsUrl: nats.url, trace: true });
  const errors = [];
  try {
    check(s.ready, 'pay-risk arrancó (rol pay_risk, NATS privado, OTel → Jaeger)');
    const h = (key) => ({ 'x-service-id': 'pay-payments', 'idempotency-key': key });
    const body = { merchant_id: 'mc_gate0000001', payment_intent_id: 'pi_gate0000001', amount_minor: 10000, currency: 'BOB', method: 'card', payer_fingerprint: SENT.huella_pan, screening: { merchant_name: SENT.razon_social_comercio, merchant_entity_type: 'business', name: SENT.nombre_pagador, entity_type: 'person' } };
    const ok = await http('POST', `${s.url}/assessments`, { headers: h(`gate-${rand()}-0001`), json: body });
    out(`     evaluación: ${ok.status} ${ok.text.slice(0, 140)}`);
    check(ok.status === 201, 'POST /assessments con razón social, nombre del pagador y una «huella» que es un PAN de prueba ⇒ 201');
    const repeated = await http('POST', `${s.url}/assessments`, { headers: h(`gate-${rand()}-0002`), json: { ...body, payment_intent_id: 'pi_gate0000002' } });
    check(repeated.status === 201, 'segunda evaluación (otro intento) ⇒ 201');
    const e1 = await http('POST', `${s.url}/assessments`, { headers: h(`gate-${rand()}-0003`), json: { ...body, cvv: '123', screening: { ...body.screening, dob: SENT.nombre_pagador } } });
    const e2 = await http('POST', `${s.url}/assessments`, { headers: { 'x-service-id': 'pay-edge', 'idempotency-key': `gate-${rand()}-0004` }, json: body });
    const e3 = await http('POST', `${s.url}/assessments`, { headers: { 'x-service-id': 'pay-payments' }, json: body });
    const e4 = await http('GET', `${s.url}/assessments/ra_${SENT.nombre_pagador.toLowerCase().replace(/[^a-z0-9]/g, '')}`, { headers: { 'x-service-id': 'pay-payments' } });
    const e6 = await http('GET', `${s.url}/${SENT.razon_social_comercio.replace(/ /g, '%20')}/${SENT.huella_pan}`, { headers: { 'x-service-id': 'pay-payments' } });
    const e5 = await http('POST', `${s.url}/assessments`, { headers: h(`gate-${rand()}-0005`), body: `{"screening":{"name":"${SENT.nombre_pagador}","merchant_name":"${SENT.razon_social_comercio}"` });
    for (const [name, r] of [['campo extra cvv + dob', e1], ['servicio no autorizado', e2], ['sin Idempotency-Key', e3], ['evaluación inexistente', e4], ['JSON truncado con los nombres', e5], ['ruta con razón social y PAN en el path', e6]]) {
      out(`     error provocado «${name}»: ${r.status} ${r.text.slice(0, 110).replace(/\s+/g, ' ')}`);
      errors.push(r.text);
    }
    check([e1, e2, e3, e4, e5, e6].every((r) => r.status >= 400 && r.status < 500), 'los seis errores provocados responden 4xx (ninguno 5xx)');
    const c = await serviceClient('pay-risk', s.db);
    let dump = '';
    try {
      const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename);
      for (const t of tables) dump += (await c.query(`SELECT t::text AS r FROM "${t}" t`)).rows.map((r) => r.r).join('\n');
      out(`     base completa (${tables.length} tablas: ${tables.join(', ')}) volcada para el grep`);
    } finally {
      await c.end();
    }
    const events = await outboxText('pay-risk', s.db);
    await s.stop();
    await sleep(500);
    const traces = await jaegerText(s.traceName);
    out(`     trazas: ${traces.spans} spans en Jaeger para ${s.traceName}`);
    check(traces.spans > 0, 'Jaeger recibió spans del servicio');
    out('   fuentes (pay-risk NO guarda ni registra ningún nombre: tampoco en su base):');
    grepSources(
      {
        'logs del proceso': s.log(),
        'trazas (Jaeger)': traces.text,
        'eventos del outbox': events.map((r) => r.e).join('\n'),
        'cuerpos de error devueltos': errors.join('\n'),
        'toda la base (rastro, reglas, idempotencia)': dump,
      },
      SENT,
    );
  } finally {
    await s.dispose();
  }
}

function laPazToday() {
  return new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
}

async function sensitiveSchedules(nats) {
  const SENT = { descripcion: 'DESCRIPCION-CENTINELA-S1', pan: PAN, razon_social_pagador: 'RAZON-CENTINELA-PAGADOR-S2 SRL' };
  out('\n## pay-schedules (libro mayor simulado por un doble que responde 500: el ejecutor falla en cada intento)');
  const calls = [];
  const ledger = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"code":"internal_error"}');
  });
  await new Promise((r) => ledger.listen(0, '127.0.0.1', r));
  const ledgerUrl = `http://127.0.0.1:${ledger.address().port}`;
  const s = await boot('pay-schedules', { natsUrl: nats.url, trace: true, extraEnv: { LEDGER_URL: ledgerUrl } });
  const errors = [];
  try {
    check(s.ready, 'pay-schedules arrancó (rol pay_schedules, NATS privado, OTel → Jaeger)');
    const payer = 'mc_gatepayer001';
    const beneficiary = 'mc_gatebenef001';
    const c = await serviceClient('pay-schedules', s.db);
    try {
      for (const id of [payer, beneficiary]) await c.query(`INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, 'active', now())`, [id]); // [DOBLE] de la réplica por NATS
    } finally {
      await c.end();
    }
    const today = laPazToday();
    const edge = (key, extra = {}) => ({ 'x-service-id': 'pay-edge', 'x-merchant-id': payer, 'x-pay-mode': 'test', 'idempotency-key': key, ...extra });
    const mandate = { kind: 'pay_obligation', beneficiary_merchant_id: beneficiary, amount_minor: 100000, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: Math.min(Number(today.slice(8, 10)), 28), start_date: today }, description: SENT.descripcion };
    const created = await http('POST', `${s.url}/mandates`, { headers: edge(`gate-${rand()}-0001`), json: mandate });
    out(`     mandato: ${created.status}`);
    check(created.status === 201, 'POST /mandates ⇒ 201');
    const e1 = await http('POST', `${s.url}/mandates`, { headers: edge(`gate-${rand()}-0002`), json: { ...mandate, kind: 'x', description: SENT.pan, cvv: '123', pagador: SENT.razon_social_pagador } });
    const e2 = await http('POST', `${s.url}/mandates`, { headers: edge(`gate-${rand()}-0003`, { 'x-service-id': 'pay-payments' }), json: mandate });
    const e3 = await http('POST', `${s.url}/mandates`, { headers: edge(`gate-${rand()}-0004`, { 'x-merchant-id': 'MC_malo' }), json: mandate });
    const e4 = await http('DELETE', `${s.url}/mandates/md_${SENT.descripcion.toLowerCase().replace(/[^a-z0-9]/g, '')}`, { headers: edge(`gate-${rand()}-0005`) });
    const e5 = await http('GET', `${s.url}/${SENT.razon_social_pagador.replace(/ /g, '%20')}/${SENT.pan}`, { headers: edge(`gate-${rand()}-0006`) });
    for (const [name, r] of [['cuerpo inválido con PAN en description + cvv', e1], ['servicio no autorizado', e2], ['comercio mal formado', e3], ['cancelar inexistente', e4], ['ruta con razón social y PAN en el path', e5]]) {
      out(`     error provocado «${name}»: ${r.status} ${r.text.slice(0, 110).replace(/\s+/g, ' ')}`);
      errors.push(r.text);
    }
    check([e1, e2, e3, e4, e5].every((r) => r.status >= 400 && r.status < 500), 'los cinco errores provocados responden 4xx');
    const worked = await until(() => calls.length >= 2, 20_000);
    out(`     el ejecutor llamó al libro mayor simulado ${calls.length} veces (${[...new Set(calls)].join(' | ')})`);
    check(worked, 'el ejecutor corrió (el mandato vence hoy) y falló contra el doble — así se generan logs de error reales');
    const events = await outboxText('pay-schedules', s.db);
    out(`     eventos en el outbox: ${[...new Set(events.map((r) => r.type))].join(', ')}`);
    await s.stop();
    await sleep(500);
    const traces = await jaegerText(s.traceName);
    out(`     trazas: ${traces.spans} spans en Jaeger para ${s.traceName}`);
    check(traces.spans > 0, 'Jaeger recibió spans del servicio');
    out('   fuentes (la descripción del mandato es dato del comercio: puede estar en la API y en su evento mandate.created si el contrato lo define; nunca en logs ni trazas):');
    grepSources(
      {
        'logs del proceso': s.log(),
        'trazas (Jaeger)': traces.text,
        'eventos del outbox': events.map((r) => r.e).join('\n'),
        'cuerpos de error devueltos': errors.join('\n'),
      },
      SENT,
      { 'eventos del outbox': ['descripcion'] },
    );
  } finally {
    await s.dispose();
    await new Promise((r) => ledger.close(r));
  }
}

// ───────────────────────── 3 · FALLOS ─────────────────────────

async function faults() {
  out('# Gate: FALLOS — experimentos de inyección de fallos (cada uno: hipótesis, inyección, observación)');
  const nats = await startPrivateNats();
  try {
    // F1 pay-risk: Watchman inalcanzable ⇒ review, nunca allow.
    out('\n## F1 · pay-risk con Watchman caído');
    out('   Hipótesis: si el cribado no responde, la evaluación termina en `review` (`screening_unavailable`, screened=false) y NUNCA en `allow`; el servicio sigue sano.');
    {
      const s = await boot('pay-risk', { natsUrl: nats.url, extraEnv: { WATCHMAN_URL: 'http://127.0.0.1:1' } });
      try {
        check(s.ready, 'pay-risk arranca con WATCHMAN_URL inalcanzable (127.0.0.1:1)');
        const r = await http('POST', `${s.url}/assessments`, { headers: { 'x-service-id': 'pay-payments', 'idempotency-key': `gate-${rand()}-f1` }, json: { merchant_id: 'mc_gate0000001', payment_intent_id: 'pi_gate0000001', amount_minor: 5000, currency: 'BOB', method: 'qr', screening: { merchant_name: 'COMERCIO SINTETICO' } } });
        out(`     observado: ${r.status} ${JSON.stringify({ decision: r.json?.decision, reason_code: r.json?.reason_code, screened: r.json?.screened })}`);
        check(r.status === 201 && r.json?.decision === 'review' && r.json?.screened === false && r.json?.decision !== 'allow', 'Watchman caído ⇒ 201 review, screened=false, nunca allow');
        check((await http('GET', `${s.url}/health/ready`)).status === 200, 'el servicio sigue respondiendo /health/ready 200');
      } finally {
        await s.dispose();
      }
    }
    // F2 los tres servicios: se cortan las conexiones de Postgres en caliente.
    out('\n## F2 · cada servicio con las conexiones de Postgres cortadas en caliente (pg_terminate_backend)');
    out('   Hipótesis: el proceso NO muere (un `error` del pool sin manejador lo mata: se halló y corrigió en este gate); la siguiente petición reconecta y responde.');
    const probes = {
      'pay-merchants': (s) => http('GET', `${s.url}/merchants/mc_abcdefghij12`, { headers: { 'x-service-id': 'pay-backoffice', authorization: `Bearer ${JWT.token(['merchant_operator'])}` } }),
      'pay-risk': (s) => http('GET', `${s.url}/assessments/ra_abcdefghij12`, { headers: { 'x-service-id': 'pay-payments' } }),
      'pay-schedules': (s) => http('GET', `${s.url}/mandates`, { headers: { 'x-service-id': 'pay-edge', 'x-merchant-id': 'mc_gatepayer009', 'x-pay-mode': 'test' } }),
    };
    const expected = { 'pay-merchants': 404, 'pay-risk': 404, 'pay-schedules': 200 };
    for (const svc of SERVICES) {
      const s = await boot(svc, { natsUrl: nats.url });
      try {
        check((await probes[svc](s)).status === expected[svc], `${svc}: antes del corte la petición de prueba responde ${expected[svc]}`);
        const a = await admin();
        let killed;
        try {
          killed = (await a.query(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2`, [s.db, roleOf(svc)])).rows[0].n;
        } finally {
          await a.end();
        }
        out(`     inyección: ${killed} conexiones de ${svc} terminadas`);
        let status = 0;
        const recovered = await until(async () => ((status = (await probes[svc](s)).status) === expected[svc]), 20_000, 500);
        out(`     observado tras el corte: ${status}${recovered ? '' : ' (no se recuperó)'}; proceso ${s.exited() ? `MUERTO ${JSON.stringify(s.exited())}` : 'vivo'}`);
        if (!recovered) out(`     cola del log:\n${s.log().trim().split('\n').slice(-6).map((l) => `       ${l.slice(0, 260)}`).join('\n')}`);
        check(recovered && !s.exited(), `${svc}: el proceso sigue vivo y se recupera solo tras el corte`);
        check((await http('GET', `${s.url}/health/ready`)).status === 200, `${svc}: /health/ready vuelve a 200`);
      } finally {
        await s.dispose();
      }
    }
    out('\n   (pay-risk, además: la misma clave repetida tras el corte devuelve 200 y deja UN solo rastro)');
    {
      const s = await boot('pay-risk', { natsUrl: nats.url });
      try {
        const post = (n) => http('POST', `${s.url}/assessments`, { headers: { 'x-service-id': 'pay-payments', 'idempotency-key': `gate-f2-${n}-${s.db}` }, json: { merchant_id: 'mc_gate0000002', payment_intent_id: `pi_gatef2000${n}`, amount_minor: 5000, currency: 'BOB', method: 'qr', screening: { merchant_name: 'COMERCIO SINTETICO' } } });
        check((await post(1)).status === 201, 'pay-risk: evaluación antes del corte ⇒ 201');
        const a = await admin();
        try {
          await a.query(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = $1 AND usename = $2`, [s.db, roleOf('pay-risk')]);
        } finally {
          await a.end();
        }
        check(await until(async () => (await post(2)).status === 201, 20_000, 500), 'pay-risk: tras el corte, una evaluación nueva ⇒ 201');
        check((await post(2)).status === 200, 'pay-risk: repetir la misma clave ⇒ 200 (misma decisión), no un duplicado');
        const c = await serviceClient('pay-risk', s.db);
        try {
          const n = (await c.query(`SELECT count(*)::int AS n FROM risk_assessments WHERE payment_intent_id = 'pi_gatef20002'`)).rows[0].n;
          check(n === 1, `pay-risk: un solo rastro para el intento reintentado (hay ${n})`);
        } finally {
          await c.end();
        }
      } finally {
        await s.dispose();
      }
    }
    // F3 pay-merchants: NATS caído ⇒ el alta sigue y el evento espera en el outbox; al volver, se publica una sola vez.
    out('\n## F3 · pay-merchants con NATS detenido y luego restablecido');
    out('   Hipótesis: con NATS caído el alta responde 201 igual (outbox transaccional); el evento queda pendiente; al volver NATS se publica UNA vez.');
    {
      const s = await boot('pay-merchants', { natsUrl: nats.url });
      try {
        check(s.ready, 'pay-merchants arranca con NATS arriba');
        nats.stop();
        out('     inyección: NATS privado detenido');
        const bo = { 'x-service-id': 'pay-backoffice', authorization: `Bearer ${JWT.token(['merchant_operator'])}` };
        const r = await http('POST', `${s.url}/merchants`, { headers: { ...bo, 'idempotency-key': `gate-${rand()}-f3` }, json: { display_name: 'FALLO NATS', legal_name: 'FALLO NATS SRL', legal_type: 'srl', tax_id: '55512345' } });
        check(r.status === 201, `con NATS caído el alta responde 201 (observado ${r.status})`);
        const c = await serviceClient('pay-merchants', s.db);
        try {
          const pending = (await c.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'merchant.created' AND published_at IS NULL`)).rows[0].n;
          check(pending === 1, `el evento merchant.created queda PENDIENTE en el outbox (pendientes: ${pending})`);
          nats.start();
          out('     restablecimiento: NATS privado reiniciado');
          const published = await until(async () => (await c.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'merchant.created' AND published_at IS NOT NULL`)).rows[0].n === 1, 60_000, 500);
          check(published, 'al volver NATS el relé publica el evento (published_at registrado)');
          await sleep(1500);
          check((await nats.streamMessages('PAY_MERCHANTS')) === 1, 'el stream PAY_MERCHANTS tiene exactamente 1 mensaje (sin duplicados)');
        } finally {
          await c.end();
        }
      } finally {
        await s.dispose();
      }
    }
    // F4 pay-schedules: libro mayor con 500 (resultado ambiguo) ⇒ se conserva el estado, se reintenta con la MISMA clave, nunca se anula.
    out('\n## F4 · pay-schedules con el libro mayor respondiendo 500 (resultado ambiguo, regla 11)');
    out('   Hipótesis: el pago NO se anula ni se marca ejecutado; cada reintento usa la MISMA Idempotency-Key; al agotar la política queda failed `ledger_unavailable` A REVISIÓN y nunca se llama a /void.');
    {
      const seen = [];
      const ledger = createServer((req, res) => {
        seen.push({ m: req.method, u: req.url, k: req.headers['idempotency-key'] });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"code":"internal_error"}');
      });
      await new Promise((r) => ledger.listen(0, '127.0.0.1', r));
      const s = await boot('pay-schedules', { natsUrl: nats.url, extraEnv: { LEDGER_URL: `http://127.0.0.1:${ledger.address().port}`, RETRY_DELAYS_SECONDS: '1,1' } });
      try {
        const c = await serviceClient('pay-schedules', s.db);
        try {
          for (const id of ['mc_gatepayer002', 'mc_gatebenef002']) await c.query(`INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, 'active', now())`, [id]);
          const today = laPazToday();
          const created = await http('POST', `${s.url}/mandates`, { headers: { 'x-service-id': 'pay-edge', 'x-merchant-id': 'mc_gatepayer002', 'x-pay-mode': 'test', 'idempotency-key': `gate-${rand()}-f4` }, json: { kind: 'pay_obligation', beneficiary_merchant_id: 'mc_gatebenef002', amount_minor: 100000, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: Math.min(Number(today.slice(8, 10)), 28), start_date: today } } });
          check(created.status === 201, 'mandato creado');
          if (laPazToday().slice(8, 10) > '28') await c.query(`UPDATE mandates SET next_run_on = $1::date WHERE id = $2`, [today, created.json.id]); // [DOBLE DEL RELOJ] los días 29–31
          const final = await until(async () => (await c.query(`SELECT status FROM scheduled_payments`)).rows.some((r) => r.status === 'failed'), 30_000, 500);
          const row = (await c.query(`SELECT status, attempts, needs_review, last_failure_code, ledger_transaction_id FROM scheduled_payments`)).rows[0];
          out(`     observado: ${JSON.stringify(row)}`);
          out(`     llamadas al libro mayor: ${seen.length} → ${[...new Set(seen.map((x) => `${x.m} ${x.u}`))].join(' | ')}`);
          check(final && row.status === 'failed' && row.last_failure_code === 'ledger_unavailable' && row.needs_review === true && row.ledger_transaction_id === null, 'al agotar la política: failed / ledger_unavailable / a revisión, sin asiento');
          check(!seen.some((x) => /\/void/.test(x.u)) && seen.every((x) => x.m === 'POST' || x.m === 'GET'), 'jamás se llamó a /void: un 500 no prueba que no se ejecutó');
          const holdKeys = seen.filter((x) => x.u === '/holds').map((x) => x.k);
          check(holdKeys.length >= 2 && new Set(holdKeys).size === 1, `los ${holdKeys.length} reintentos de la retención usan la MISMA Idempotency-Key (${holdKeys[0]})`);
          const events = (await c.query(`SELECT type FROM outbox_events WHERE type LIKE 'scheduled_payment.%'`)).rows.map((r) => r.type);
          check(events.length === 1 && events[0] === 'scheduled_payment.failed', `un solo aviso: ${events.join(', ')}`);
        } finally {
          await c.end();
        }
      } finally {
        await s.dispose();
        await new Promise((r) => ledger.close(r));
      }
    }
    // F5 pay-schedules: kill -9 del proceso y reinicio sobre la misma base.
    out('\n## F5 · pay-schedules muerto con SIGKILL y reiniciado sobre la misma base');
    out('   Hipótesis: el estado en la base sobrevive; al reiniciar el servicio retoma el pago pendiente sin duplicarlo (UNIQUE mandato+periodo).');
    {
      const ledger = createServer((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"code":"internal_error"}');
      });
      await new Promise((r) => ledger.listen(0, '127.0.0.1', r));
      const extra = { LEDGER_URL: `http://127.0.0.1:${ledger.address().port}`, RETRY_DELAYS_SECONDS: '30,30' };
      const first = await boot('pay-schedules', { natsUrl: nats.url, extraEnv: extra });
      let second;
      try {
        const c = await serviceClient('pay-schedules', first.db);
        try {
          for (const id of ['mc_gatepayer003', 'mc_gatebenef003']) await c.query(`INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, 'active', now())`, [id]);
          const today = laPazToday();
          const created = await http('POST', `${first.url}/mandates`, { headers: { 'x-service-id': 'pay-edge', 'x-merchant-id': 'mc_gatepayer003', 'x-pay-mode': 'test', 'idempotency-key': `gate-${rand()}-f5` }, json: { kind: 'pay_obligation', beneficiary_merchant_id: 'mc_gatebenef003', amount_minor: 100000, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: Math.min(Number(today.slice(8, 10)), 28), start_date: today } } });
          if (today.slice(8, 10) > '28') await c.query(`UPDATE mandates SET next_run_on = $1::date WHERE id = $2`, [today, created.json.id]);
          await until(async () => (await c.query(`SELECT attempts FROM scheduled_payments`)).rows.some((r) => r.attempts >= 1), 20_000, 300);
          const before = (await c.query(`SELECT id, status, attempts FROM scheduled_payments`)).rows;
          process.kill(first.pid, 'SIGKILL');
          await first.stop();
          out(`     inyección: SIGKILL a pid ${first.pid}; filas antes: ${JSON.stringify(before)}`);
          // mismo esquema/base: arrancar otro proceso apuntando a la misma base temporal
          const port = await freePort();
          const fd = openSync(join(first.runDir, 'segundo.log'), 'a');
          const child = spawn(process.execPath, ['dist/main.js'], { cwd: join(ROOT, 'services/pay-schedules'), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: String(port), LOG_LEVEL: 'info', DB_HOST: ADMIN.host, DB_PORT: String(ADMIN.port), DB_NAME: first.db, DB_USER: roleOf('pay-schedules'), DB_PASSWORD: passwordOf('pay-schedules'), PAY_MODE: 'sandbox', NATS_URL: nats.url, RUN_INTERVAL_SECONDS: '1', ...extra }, stdio: ['ignore', fd, fd] });
          closeSync(fd);
          second = child;
          const up = await until(async () => (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200, 60_000);
          check(up, 'el servicio reiniciado sobre la misma base queda listo');
          await sleep(3000);
          const after = (await c.query(`SELECT id, status, attempts FROM scheduled_payments`)).rows;
          out(`     filas después del reinicio: ${JSON.stringify(after)}`);
          check(after.length === before.length && after[0].id === before[0].id, 'el mismo pago programado sobrevive (una sola fila para el periodo)');
          check(['due', 'waiting_funds'].includes(after[0].status) || after[0].status === 'failed', `el pago sigue en un estado conocido (${after[0].status}) y NO ejecutado sin asiento`);
        } finally {
          await c.end();
        }
      } finally {
        if (second) {
          second.kill('SIGTERM');
          await sleep(1000);
          if (second.exitCode === null) second.kill('SIGKILL');
        }
        await first.dispose();
        await new Promise((r) => ledger.close(r));
      }
    }
  } finally {
    nats.remove();
  }
}

// ───────────────────────── 4 · DERIVA DE ESQUEMA ─────────────────────────

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.spec.ts')) yield p;
  }
}

async function drift() {
  out('# Gate: DERIVA DE ESQUEMA — SQL del servicio ↔ base real ↔ consultas del código');
  out('# Se aplica el DDL de cada servicio a una base temporal y se verifican, contra information_schema, las sentencias INSERT / UPDATE / FROM / JOIN literales del código:');
  out('# tabla ausente, columna ausente y columna obligatoria (NOT NULL sin valor por defecto) no mapeada en un INSERT. La nulabilidad contra el MODELO (.puml) no se puede comprobar: ver GAP.');
  for (const svc of SERVICES) {
    out(`\n## ${svc}`);
    const db = await createTempDatabase(svc);
    const c = await serviceClient(svc, db);
    try {
      const cols = (await c.query(`SELECT table_name, column_name, is_nullable, column_default, is_identity, is_generated FROM information_schema.columns WHERE table_schema = 'public'`)).rows;
      const tables = new Map();
      for (const r of cols) {
        if (!tables.has(r.table_name)) tables.set(r.table_name, new Map());
        tables.get(r.table_name).set(r.column_name, r);
      }
      out(`     base temporal: ${tables.size} tablas, ${cols.length} columnas`);
      const problems = [];
      let inserts = 0;
      let updates = 0;
      let refs = 0;
      // Las librerías @pay/* solo cuentan si el servicio las usa: su DDL trae esas tablas técnicas (pay-risk no usa outbox/inbox y su ddl.sql no las trae).
      const sources = [
        ...walk(join(ROOT, 'services', svc, 'src')),
        ...(tables.has('outbox_events') ? walk(join(ROOT, 'contracts/packages/outbox/src')) : []),
        ...(tables.has('idempotency_keys') ? walk(join(ROOT, 'contracts/packages/idempotency/src')) : []),
      ];
      for (const file of sources) {
        const text = readFileSync(file, 'utf8');
        const rel = file.replace(`${ROOT}/`, '');
        for (const m of text.matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
          inserts += 1;
          const [, table, list] = m;
          const t = tables.get(table);
          if (!t) {
            problems.push(`${rel}: INSERT en tabla AUSENTE ${table}`);
            continue;
          }
          const names = list.split(',').map((x) => x.trim()).filter(Boolean);
          for (const n of names) if (!t.has(n)) problems.push(`${rel}: INSERT ${table}: columna AUSENTE ${n}`);
          for (const [name, col] of t) {
            const mandatory = col.is_nullable === 'NO' && col.column_default === null && col.is_identity === 'NO' && col.is_generated === 'NEVER';
            if (mandatory && !names.includes(name)) problems.push(`${rel}: INSERT ${table}: columna OBLIGATORIA no mapeada ${name}`);
          }
        }
        for (const m of text.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|\s+RETURNING\b|`|"|')/gi)) {
          const [, table, set] = m;
          if (!/^[a-z_]+$/.test(table) || ['set', 'only'].includes(table.toLowerCase())) continue;
          updates += 1;
          const t = tables.get(table);
          if (!t) {
            problems.push(`${rel}: UPDATE en tabla AUSENTE ${table}`);
            continue;
          }
          let depth = 0;
          let current = '';
          const parts = [];
          for (const ch of set) {
            if (ch === '(') depth += 1;
            if (ch === ')') depth -= 1;
            if (ch === ',' && depth === 0) {
              parts.push(current);
              current = '';
            } else current += ch;
          }
          parts.push(current);
          for (const part of parts) {
            const name = /^\s*(\w+)\s*=/.exec(part)?.[1];
            if (name && !t.has(name)) problems.push(`${rel}: UPDATE ${table}: columna AUSENTE ${name}`);
          }
        }
        for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\b(?:\s+(?:AS\s+)?\w+)?/g)) {
          const table = m[1];
          if (['select', 'information_schema', 'unnest', 'generate_series', 'lateral', 'only', 'jsonb_array_elements'].includes(table) || table.startsWith('pg_') || table.startsWith('jsonb') || table === 'now') continue;
          // sólo dentro de literales SQL: evita palabras de comentarios («de la tabla …»)
          const before = text.slice(Math.max(0, m.index - 200), m.index);
          if (!/(SELECT|DELETE|UPDATE|EXISTS|WITH|USING|\()[\s\S]*$/i.test(before) || /\/\/|\*\s/.test(text.slice(text.lastIndexOf('\n', m.index), m.index))) continue;
          refs += 1;
          if (!tables.has(table)) problems.push(`${rel}: FROM/JOIN en tabla AUSENTE ${table}`);
        }
      }
      out(`     sentencias examinadas: ${inserts} INSERT, ${updates} UPDATE, ${refs} FROM/JOIN`);
      for (const p of [...new Set(problems)]) out(`     ! ${p}`);
      check(problems.length === 0, `${svc}: sin tabla ausente, columna ausente ni columna obligatoria no mapeada (${new Set(problems).size} hallazgos)`);
    } finally {
      await c.end();
      await dropTempDatabase(db);
    }
  }
}

async function ddlOrder() {
  out('# Gate: el DDL vendorizado se aplica limpio en los dos escenarios (con y sin el 001_*.sql de referencia), por el rol dueño, y dos veces');
  for (const svc of SERVICES) {
    out(`\n## ${svc}`);
    const scenarios = { 'arnés e2e HOY (librerías + todo sql/*.sql)': e2eHarnessDdlFiles(svc), 'solo ddl.sql (estado final)': ddlFiles(svc), 'librerías + ddl.sql (arnés e2e tras borrar el 001)': [...e2eHarnessDdlFiles(svc).filter((f) => f.includes('contracts/packages')), ...ddlFiles(svc)] };
    for (const [name, files] of Object.entries(scenarios)) {
      const db = `p5gate_ddl_${svc.replace('pay-', '')}_${rand()}`;
      const a = await admin();
      try {
        await a.query(`CREATE DATABASE ${db} OWNER ${roleOf(svc)}`);
      } finally {
        await a.end();
      }
      const owner = new pg.Client({ host: ADMIN.host, port: ADMIN.port, database: db, user: roleOf(svc), password: passwordOf(svc) });
      await owner.connect();
      let error;
      try {
        for (let pass = 1; pass <= 2; pass += 1) for (const f of files) await owner.query(readFileSync(f, 'utf8'));
        const tables = (await owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
        out(`     ${name}: ${files.map((f) => f.replace(`${ROOT}/`, '')).join(' + ')} ×2 ⇒ ${tables} tablas`);
      } catch (e) {
        error = e;
      } finally {
        await owner.end();
        await dropTempDatabase(db);
      }
      check(error === undefined, `${svc}: ${name} se aplica sin error${error ? ` (${error.message})` : ''}`);
    }
  }
}

async function truncateGate() {
  out('# Gate: TRUNCATE rechazado en las tablas inmutables, con el ROL DE LA APLICACIÓN (no superusuario, dueño de la base) — modelo af60b79 / INTEGRACION.md §7.4');
  const db = await createTempDatabase('pay-merchants');
  const c = await serviceClient('pay-merchants', db);
  try {
    const who = (await c.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows[0];
    out(`     rol: ${JSON.stringify(who)} sobre ${db}`);
    check(who.u === 'pay_merchants' && who.su === false, 'se opera con pay_merchants (no superusuario)');
    for (const table of ['contract_versions', 'contract_acceptances', 'fee_schedule_versions', 'fee_schedule_channels']) {
      for (const verb of ['TRUNCATE']) {
        let message = '';
        try {
          await c.query(`${verb} ${table}${verb === 'TRUNCATE' ? ' CASCADE' : ''}`);
        } catch (error) {
          message = String(error.message);
        }
        out(`     ${verb} ${table}: ${message || 'NO FALLÓ'}`);
        check(/inmutable/.test(message), `${verb} ${table} lo rechaza el trigger (inmutable)`);
      }
    }
    await c.query(`INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (900, repeat('a', 64), now(), 'sintetico')`);
    for (const sql of ["UPDATE contract_versions SET published_by = 'otro' WHERE version = 900", 'DELETE FROM contract_versions WHERE version = 900']) {
      let message = '';
      try {
        await c.query(sql);
      } catch (error) {
        message = String(error.message);
      }
      out(`     ${sql}: ${message || 'NO FALLÓ'}`);
      check(/inmutable/.test(message), `con una fila presente: «${sql.split(' WHERE')[0]}» lo rechaza el trigger de fila`);
    }
    let ok = true;
    try {
      await c.query('TRUNCATE api_keys');
    } catch {
      ok = false;
    }
    check(ok, 'control: api_keys (no inmutable) sí se puede vaciar — el guardián es específico de las tablas inmutables');
    const triggers = (await c.query(`SELECT c.relname AS t, g.tgname AS trigger_name FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND (g.tgtype & 32) <> 0 ORDER BY 1, 2`)).rows;
    out(`     triggers BEFORE TRUNCATE: ${triggers.map((r) => `${r.t}.${r.trigger_name}`).join(', ')}`);
    check(['contract_versions', 'fee_schedule_channels', 'contract_acceptances', 'fee_schedule_versions'].every((t) => triggers.some((r) => r.t === t)), 'las cuatro tablas inmutables tienen su trigger BEFORE TRUNCATE');
  } finally {
    await c.end();
    await dropTempDatabase(db);
  }
}

/** Hallazgo informativo (no hace fallar el gate): una Idempotency-Key con forma de PAN, ¿dónde queda? Es entrada del cliente y el contrato no la restringe. */
async function idemPan() {
  out('# Sonda: Idempotency-Key con forma de PAN (4111111111111111) — ¿llega a logs, respuestas o a la base?');
  const nats = await startPrivateNats();
  try {
    const plans = {
      'pay-merchants': (s) => http('POST', `${s.url}/merchants`, { headers: { 'x-service-id': 'pay-backoffice', authorization: `Bearer ${JWT.token(['merchant_operator'])}`, 'idempotency-key': PAN }, json: { display_name: 'SONDA', legal_name: 'SONDA SRL', legal_type: 'srl', tax_id: '77000111' } }),
      'pay-risk': (s) => http('POST', `${s.url}/assessments`, { headers: { 'x-service-id': 'pay-payments', 'idempotency-key': PAN }, json: { merchant_id: 'mc_gate0000009', payment_intent_id: 'pi_gate0000009', amount_minor: 100, currency: 'BOB', method: 'qr', screening: { merchant_name: 'SONDA' } } }),
      'pay-schedules': async (s) => {
        const c = await serviceClient('pay-schedules', s.db);
        try {
          for (const id of ['mc_gatepayer009', 'mc_gatebenef009']) await c.query(`INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, 'active', now())`, [id]);
        } finally {
          await c.end();
        }
        const today = laPazToday();
        return http('POST', `${s.url}/mandates`, { headers: { 'x-service-id': 'pay-edge', 'x-merchant-id': 'mc_gatepayer009', 'x-pay-mode': 'test', 'idempotency-key': PAN }, json: { kind: 'pay_obligation', beneficiary_merchant_id: 'mc_gatebenef009', amount_minor: 100, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: Math.min(Number(today.slice(8, 10)), 28), start_date: today } } });
      },
    };
    for (const svc of SERVICES) {
      const s = await boot(svc, { natsUrl: nats.url });
      try {
        const res = await plans[svc](s);
        const c = await serviceClient(svc, s.db);
        const where = [];
        try {
          const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename);
          for (const t of tables) if ((await c.query(`SELECT t::text AS r FROM "${t}" t`)).rows.some((r) => r.r.includes(PAN))) where.push(`tabla ${t}`);
        } finally {
          await c.end();
        }
        if (s.log().includes(PAN)) where.push('log del proceso');
        if (JSON.stringify(res.json ?? res.text).includes(PAN)) where.push('respuesta');
        out(`     ${svc}: petición ${res.status}; la clave con forma de PAN aparece en: ${where.length ? where.join(', ') : 'ninguna parte'}`);
        out(`${where.length ? 'HALLAZGO' : 'OK      '}  ${svc}: Idempotency-Key con forma de PAN ${where.length ? `persiste en ${where.join(', ')}` : 'no se persiste ni se registra'}`);
      } finally {
        await s.dispose();
      }
    }
  } finally {
    nats.remove();
  }
}

// ───────────────────────── entrada ─────────────────────────

const commands = { separation, sensitive, faults, drift, 'ddl-order': ddlOrder, truncate: truncateGate, 'idem-pan': idemPan };
const which = process.argv[2];
const run = which === 'all' ? Object.keys(commands) : [which];
if (!run.every((c) => commands[c])) {
  process.stderr.write(`Uso: node scripts/p5-gates.mjs <${Object.keys(commands).join('|')}|all>\n`);
  process.exit(2);
}
try {
  for (const name of run) await commands[name]();
} catch (error) {
  out(`FAIL  error inesperado: ${error.stack ?? error}`);
  failures += 1;
}
out(`\nresultado: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
