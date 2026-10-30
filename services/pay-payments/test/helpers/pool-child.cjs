// Arnés de proceso hijo para pg-pool.error.spec.ts: crea el pool con `createPgPool` de dist/ (o, como CONTROL NEGATIVO, un `new Pool` pelado
// o con SOLO el manejador del pool —el que no cubre las conexiones prestadas—) y atiende órdenes por stdin.
const path = require('node:path');
const readline = require('node:readline');
const { Pool } = require('pg');

const options = { connectionString: process.env.POOL_URL, max: 4, application_name: process.env.POOL_APP };
let pool;
if (process.env.POOL_BARE === '1') pool = new Pool(options);
else if (process.env.POOL_IDLE_ONLY === '1') {
  pool = new Pool(options);
  pool.on('error', () => undefined);
} else pool = require(path.join(process.cwd(), 'dist/pg-pool.js')).createPgPool(options);
const reply = (id, body) => process.stdout.write(`REPLY ${JSON.stringify({ id, ...body })}\n`);
const failure = (id) => (e) => reply(id, { error: e.name, code: e.code });
let held;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op } = JSON.parse(line);
  if (op === 'ping') pool.query('SELECT 1 AS ok').then((r) => reply(id, { ok: r.rows[0].ok === 1 }), failure(id));
  else if (op === 'spread') Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT pg_sleep(0.4)'))).then(() => reply(id, { ok: true }), failure(id));
  else if (op === 'sleep') pool.query('SELECT pg_sleep(60)').then(() => reply(id, { ok: true }), failure(id));
  // Transacción: el cliente PRESTADO (`pool.connect()`) queda dentro de un BEGIN. El pool le quita su escucha de `error` mientras está prestado.
  else if (op === 'tx_open') pool.connect().then(async (client) => { held = client; await client.query('BEGIN'); await client.query('CREATE TEMP TABLE IF NOT EXISTS t3c (n int)'); await client.query('INSERT INTO t3c VALUES (1)'); reply(id, { ok: true }); }, failure(id));
  else if (op === 'tx_next') held.query('INSERT INTO t3c VALUES (2)').then(() => reply(id, { ok: true }), failure(id)).finally(() => held.release(true));
  else if (op === 'tx_sleep') held.query('SELECT pg_sleep(60)').then(() => reply(id, { ok: true }), failure(id)).finally(() => held.release(true));
});
process.stdout.write('READY\n');
