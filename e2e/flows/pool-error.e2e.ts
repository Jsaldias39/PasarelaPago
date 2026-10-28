import { Client } from 'pg';
import { until } from '../lib/wait.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * Hallazgo transversal de P5: un `pg.Pool` sin manejador de `error` tira el PROCESO cuando Postgres corta una conexión ociosa. Acá, con los procesos REALES
 * (`node dist/main.js`) de pay-edge y pay-webhooks: se les abre trabajo para que tengan conexiones en el pool, se cortan TODAS sus sesiones con
 * `pg_terminate_backend` desde fuera y se comprueba que los procesos siguen vivos (mismo PID) y vuelven a contestar `/health/ready` con la base `up`.
 */
describe('pool de pg: cortar las conexiones de Postgres no mata a pay-edge ni a pay-webhooks', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ only: ['pay-edge', 'pay-webhooks'], tolerateFailures: false, warmUp: false });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it.each([
    ['pay-edge', 'pay_edge', 'dev_only_edge'],
    ['pay-webhooks', 'pay_webhooks', 'dev_only_webhooks'],
  ] as const)('%s sigue vivo y sano tras cortarle todas las sesiones', async (name, database, password) => {
    const pidBefore = stack.processes.get(name)!.pid;
    // Hace que el pool abra al menos una conexión (la readiness consulta la base).
    expect((await stack.call(name, 'GET', '/health/ready')).status).toBe(200);
    const admin = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database, user: database, password });
    await admin.connect();
    let terminated = 0;
    try {
      const res = await admin.query<{ ok: boolean }>(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = $1 AND usename = $1 AND application_name = $2 AND pid <> pg_backend_pid()`, [database, name]);
      terminated = res.rows.length;
      expect(res.rows.every((r) => r.ok)).toBe(true);
    } finally {
      await admin.end().catch(() => undefined);
    }
    expect(terminated).toBeGreaterThan(0);
    const ready = await until(`${name} vuelve a estar listo`, async () => (await stack.call(name, 'GET', '/health/ready').catch(() => undefined))?.status ?? 0, (status) => status === 200, 20_000, 250);
    expect(ready).toBe(200);
    expect(stack.processes.get(name)!.exit).toBeUndefined();
    expect(stack.processes.get(name)!.pid).toBe(pidBefore);
  });
});
