import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { connect } from 'nats';
import { Client } from 'pg';
import { spawnProcess, tailLog, waitFor, type Managed } from './process.ts';
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
const TB_BIN = join(ROOT, '.tools/tigerbeetle/tigerbeetle');

const TB_CACHE = join(ROOT, 'e2e/.run/bin/tigerbeetle');

/**
 * Binario de TigerBeetle. Se guarda una copia propia en `e2e/.run/bin` porque otro proceso (el script de la plataforma, que
 * re-descomprime o borra `.tools/tigerbeetle`) puede quitar el del script a mitad de una corrida. Si no hay ninguno, lo baja el script.
 */
function ensureTigerBeetleBinary(): string {
  if (existsSync(TB_CACHE)) return TB_CACHE;
  if (!existsSync(TB_BIN)) {
    const running = execFileSync('bash', [TB_SCRIPT, 'status'], { encoding: 'utf8' }).trim().startsWith('corriendo');
    execFileSync('bash', [TB_SCRIPT, 'start'], { encoding: 'utf8' });
    if (!running) execFileSync('bash', [TB_SCRIPT, 'stop'], { encoding: 'utf8' });
  }
  mkdirSync(dirname(TB_CACHE), { recursive: true });
  copyFileSync(TB_BIN, TB_CACHE);
  chmodSync(TB_CACHE, 0o755);
  return TB_CACHE;
}

/**
 * TigerBeetle PROPIO de la corrida: mismo binario que usa `platform/scripts/tigerbeetle-dev.sh` (si falta, el script lo descarga),
 * pero con archivo de datos y puerto propios, para no pisar al TigerBeetle compartido del script ni que otro lo detenga a mitad de
 * una corrida. Los datos viven en el directorio de la corrida y se borran al apagar.
 */
export async function startPrivateTigerBeetle(runDir: string, port: number): Promise<{ managed: Managed; address: string; dataFile: string }> {
  const source = ensureTigerBeetleBinary();
  // Copia del binario a la carpeta de la corrida: otro agente puede volver a descomprimir el del script mientras este corre.
  mkdirSync(runDir, { recursive: true });
  const bin = join(runDir, 'tigerbeetle');
  copyFileSync(source, bin);
  chmodSync(bin, 0o755);
  const dataFile = join(runDir, '0_0.tigerbeetle');
  execFileSync(bin, ['format', '--cluster=0', '--replica=0', '--replica-count=1', dataFile], { stdio: 'ignore' });
  const address = `127.0.0.1:${port}`;
  const managed = spawnProcess('tigerbeetle', bin, ['start', `--addresses=${address}`, dataFile], ROOT, {}, join(runDir, 'tigerbeetle.log'));
  const ready = await waitFor(() => tcpOpen(address), 30_000, () => (managed.exit ? 'tigerbeetle terminó antes de abrir el puerto' : undefined));
  if (!ready.ok) throw new Error(`TigerBeetle no quedó listo: ${ready.reason}\n${tailLog(join(runDir, 'tigerbeetle.log'))}`);
  return { managed, address, dataFile };
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

/** Certificado autofirmado SOLO de pruebas para el receptor local de webhooks (SAN IP:127.0.0.1). */
export function makeReceiverCertificate(runDir: string): { certFile: string; keyFile: string } {
  const certFile = join(runDir, 'receiver-cert.pem');
  const keyFile = join(runDir, 'receiver-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  return { certFile, keyFile };
}

