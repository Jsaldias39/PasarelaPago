#!/usr/bin/env node
// Aplica el DDL de referencia a la base de cada servicio de la capa sandbox (platform/compose.mock.yml), UNA sola vez. Los servicios no aplican DDL al arrancar.
// Mismo orden que el arnés e2e (e2e/lib/infra.ts, `ddlFiles`): primero las librerías (outbox, idempotency) y después `services/<svc>/sql`, todo con el ROL
// del propio servicio (dueño de su base). Es idempotente: si la base ya tiene tablas en `public` NO toca nada (nunca borra ni trunca). Sandbox, datos sintéticos.
//   DB_HOST=postgres DB_PORT=5432 node platform/scripts/sandbox-migrate.mjs [--only pay-edge,pay-ledger]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = ['pay-ledger', 'pay-risk', 'pay-qr', 'pay-vault', 'pay-merchants', 'pay-webhooks', 'pay-mockbank', 'pay-connectors', 'pay-payments', 'pay-settlement', 'pay-schedules', 'pay-edge'];
if (process.env.PAY_MODE !== 'sandbox') {
  process.stderr.write('sandbox-migrate: exige PAY_MODE=sandbox (nunca se corre contra live).\n');
  process.exit(2);
}
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : SERVICES;
const host = process.env.DB_HOST ?? '127.0.0.1';
const port = Number(process.env.DB_PORT ?? 54321);

const sqlIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f)) : []);
const ddlFiles = (service) => [
  ...sqlIn(join(ROOT, 'contracts/packages/outbox/sql')),
  ...sqlIn(join(ROOT, 'contracts/packages/idempotency/sql')),
  ...sqlIn(join(ROOT, 'services', service, 'sql')),
];

let failed = 0;
for (const service of only) {
  const short = service.replace('pay-', '');
  const client = new pg.Client({ host, port, database: `pay_${short}`, user: `pay_${short}`, password: `dev_only_${short}` });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    if (rows[0].n > 0) {
      process.stdout.write(`${service}: ya tiene ${rows[0].n} tablas, no se toca\n`);
      continue;
    }
    const files = ddlFiles(service);
    for (const file of files) await client.query(readFileSync(file, 'utf8'));
    process.stdout.write(`${service}: DDL aplicado (${files.length} archivos)\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`${service}: FALLA ${error.code ?? ''} ${error.message}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
process.exit(failed === 0 ? 0 : 1);
