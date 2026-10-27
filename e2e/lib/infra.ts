import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';
import { connect } from 'nats';
import { Client } from 'pg';
import { SERVICE_STREAMS, type Infra, type ServiceName } from './services.ts';

/** Raíz del monorepo: sube desde el directorio actual hasta el `package.json` de `pasarela-pago` (sirve igual en Node y en Jest). */
function findRoot(): string {
  for (let dir = process.cwd(); ; dir = resolve(dir, '..')) {
    if (existsSync(join(dir, 'platform/scripts/tigerbeetle-dev.sh')) && existsSync(join(dir, 'e2e'))) return dir;
    if (resolve(dir, '..') === dir) throw new Error('No se encontró la raíz del monorepo (corré desde dentro del repo)');
  }
}
export const ROOT = findRoot();

/** ¿Acepta conexiones TCP `host:port`? */
export function tcpOpen(address: string, timeoutMs = 1500): Promise<boolean> {
  const [host, port] = [address.replace(/^[a-z]+:\/\//, '').split(':')[0], Number(address.split(':').pop())];
  return new Promise((done) => {
    const socket = netConnect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('timeout', () => (socket.destroy(), done(false)));
    socket.once('error', () => done(false));
  });
}

export interface InfraReport {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Comprueba la infraestructura del Compose. TigerBeetle se informa aparte (se arranca por su script). */
export async function checkInfra(infra: Infra): Promise<InfraReport[]> {
  const checks: [string, string][] = [
    ['postgres', `${infra.postgres.host}:${infra.postgres.port}`],
    ['nats', infra.natsUrl],
    ['redis', infra.redisUrl],
    ['temporal', infra.temporalAddress],
    ['watchman', infra.watchmanUrl],
  ];
  return Promise.all(checks.map(async ([name, address]) => ({ name, ok: await tcpOpen(address), detail: address })));
}

const TB_SCRIPT = join(ROOT, 'platform/scripts/tigerbeetle-dev.sh');

/** Arranca TigerBeetle por el script de la plataforma si no estaba corriendo. Devuelve `true` si lo arrancó ESTA llamada. */
export function ensureTigerBeetle(): { startedHere: boolean; detail: string } {
  const status = execFileSync('bash', [TB_SCRIPT, 'status'], { encoding: 'utf8' }).trim();
  if (status.startsWith('corriendo')) return { startedHere: false, detail: status };
  const out = execFileSync('bash', [TB_SCRIPT, 'start'], { encoding: 'utf8' }).trim();
  return { startedHere: true, detail: out };
}

export function stopTigerBeetle(): void {
  execFileSync('bash', [TB_SCRIPT, 'stop'], { encoding: 'utf8' });
}

const dbName = (name: ServiceName) => `pay_${name.replace('pay-', '')}`;
const dbPassword = (name: ServiceName) => `dev_only_${name.replace('pay-', '')}`;

function ddlFiles(name: ServiceName): string[] {
  const packages = ['outbox', 'idempotency'].flatMap((pkg) => {
    const dir = join(ROOT, 'contracts/packages', pkg, 'sql');
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
  });
  const own = join(ROOT, 'services', name, 'sql');
  const ownFiles = readdirSync(own).filter((f) => f.endsWith('.sql')).sort().map((f) => join(own, f));
  return [...packages, ...ownFiles];
}

/**
 * Deja la base del servicio vacía (solo el esquema `public`; los esquemas `t_*` de las pruebas de otros no se tocan) y, si se
 * pide, aplica su DDL con las credenciales del propio servicio. El DDL de referencia vive en `services/<x>/sql` y en
 * `contracts/packages/*\/sql` hasta que el pipeline del modelo (D-18) lo entregue.
 */
export async function resetDatabase(infra: Infra, name: ServiceName, applyDdl: boolean): Promise<void> {
  const role = dbName(name);
  const admin = new Client({ connectionString: `${infra.postgres.adminUrl}/${role}` });
  await admin.connect();
  try {
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.query(`CREATE SCHEMA public AUTHORIZATION ${role}`);
  } finally {
    await admin.end();
  }
  if (!applyDdl) return;
  const owner = new Client({ host: infra.postgres.host, port: infra.postgres.port, database: role, user: role, password: dbPassword(name) });
  await owner.connect();
  try {
    for (const file of ddlFiles(name)) await owner.query(readFileSync(file, 'utf8'));
  } finally {
    await owner.end();
  }
}

/** Borra los streams que crean los servicios (y con ellos sus consumidores). Devuelve los que existían. */
export async function deleteServiceStreams(infra: Infra): Promise<string[]> {
  const nc = await connect({ servers: infra.natsUrl, name: 'e2e-harness' });
  const deleted: string[] = [];
  try {
    const jsm = await nc.jetstreamManager();
    for (const stream of SERVICE_STREAMS) {
      try {
        await jsm.streams.delete(stream);
        deleted.push(stream);
      } catch {
        // no existía
      }
    }
  } finally {
    await nc.drain();
  }
  return deleted;
}
