// Arnés de proceso hijo para pg-pool.error.spec.ts: crea el pool con `createPgPool` de dist/ (o un `new Pool` pelado como CONTROL NEGATIVO) y atiende órdenes por stdin.
const path = require('node:path');
const readline = require('node:readline');
const { Pool } = require('pg');

const options = { connectionString: process.env.POOL_URL, max: 4, application_name: process.env.POOL_APP };
const pool = process.env.POOL_BARE === '1' ? new Pool(options) : require(path.join(process.cwd(), 'dist/pg-pool.js')).createPgPool(options);
const reply = (id, body) => process.stdout.write(`REPLY ${JSON.stringify({ id, ...body })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op } = JSON.parse(line);
  if (op === 'ping') pool.query('SELECT 1 AS ok').then((r) => reply(id, { ok: r.rows[0].ok === 1 }), (e) => reply(id, { error: e.name, code: e.code }));
  else if (op === 'spread') Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT pg_sleep(0.4)'))).then(() => reply(id, { ok: true }), (e) => reply(id, { error: e.name, code: e.code }));
  else if (op === 'sleep') pool.query('SELECT pg_sleep(60)').then(() => reply(id, { ok: true }), (e) => reply(id, { error: e.name, code: e.code }));
});
process.stdout.write('READY\n');
