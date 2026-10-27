/**
 * Arnés e2e (P1.H5): levanta los 11 servicios REALES (`node dist/main.js`, procesos hijos) contra la infraestructura real del
 * Compose (Postgres con una base por servicio, NATS JetStream, Redis, Temporal, Watchman) y TigerBeetle por su script, en el
 * modo de despliegue sandbox (`PAY_MODE=sandbox`, conector `mock`). Sin datos reales: los secretos se generan al vuelo.
 *
 * Contrato: `startStack()` deja la base de cada servicio vacía con su DDL de referencia aplicado, arranca por orden de
 * dependencias y espera la readiness REAL (`GET /health/ready`, nunca una pausa fija). Un servicio que no arranca NO tumba al
 * resto: queda anotado con el motivo y el final de su log (la matriz de docs/trabajo/ola-2/P1/ARNES.md sale de ahí).
 * `stopStack()` apaga los procesos (SIGTERM y, si no salen, SIGKILL por PID), vacía las bases y borra los streams.
 *
 * Un solo stack a la vez: comparten bases, streams y el puerto de TigerBeetle.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInfra, deleteServiceStreams, resetDatabase, ROOT, startPrivateTigerBeetle } from './lib/infra.ts';
import { freePorts, isOurProcess, type Managed, spawnNode, tailLog, terminate, waitFor } from './lib/process.ts';
import { DEFAULT_INFRA, DEPENDS_ON, envFor, generateSecrets, type EnvContext, type Infra, type RunSecrets, SERVICES, type ServiceName } from './lib/services.ts';

export { SERVICES, type ServiceName } from './lib/services.ts';

export const RUN_DIR = join(ROOT, 'e2e/.run');
const STATE_FILE = join(RUN_DIR, 'state.json');

export interface ServiceStatus {
  readonly name: ServiceName;
  readonly port: number;
  readonly url: string;
  readonly pid: number | undefined;
  /** El proceso arrancó y siguió vivo hasta responder. */
  started: boolean;
  /** `GET /health/ready` respondió 200. */
  healthy: boolean;
  /** Por qué no arrancó o no quedó sano. */
  error: string | undefined;
  /** Final del log cuando falló. */
  logTail: string | undefined;
  readonly logFile: string;
  startupMs: number | undefined;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

export interface CallOptions {
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface Stack {
  readonly runId: string;
  readonly runDir: string;
  readonly infra: Infra;
  readonly secrets: RunSecrets;
  readonly services: Record<ServiceName, ServiceStatus>;
  readonly processes: Map<ServiceName, Managed>;
  /** Receptor de webhooks de la prueba: puerto reservado y certificado autofirmado para 127.0.0.1 (la CA que confía pay-webhooks en sandbox). */
  readonly receiver: { readonly port: number; readonly certFile: string; readonly keyFile: string };
  /** TigerBeetle propio de la corrida (archivo y puerto propios); `undefined` si no se pidió `pay-ledger`. */
  readonly tigerbeetle: Managed | undefined;
  url(name: ServiceName): string;
  /** Llamada HTTP a un servicio (sin identidad de servicio: la pone quien llama). */
  call(name: ServiceName, method: string, path: string, options?: CallOptions): Promise<HttpResult>;
  /** Llamada interna con la identidad de otro servicio y el modo, como la haría `from`. */
  callAs(from: string, name: ServiceName, method: string, path: string, options?: CallOptions & { merchantId?: string; payMode?: 'test' | 'live' | null }): Promise<HttpResult>;
}

export interface StartOptions {
  /** Servicios a levantar; por defecto los 11. */
  readonly only?: readonly ServiceName[];
  /** `true` (por defecto): un servicio que falla se anota y se sigue. `false`: se lanza al primer fallo. */
  readonly tolerateFailures?: boolean;
  /** Tope de espera de la readiness de cada servicio. */
  readonly readyTimeoutMs?: number;
  /** Escalera de reintentos de webhooks, en ms (por defecto la de producción). */
  readonly webhookRetryScheduleMs?: string;
  readonly infra?: Infra;
  /** Cambios al entorno de un servicio (`null` borra la variable): para probar arranques degradados y armar la matriz del arnés. */
  readonly envOverrides?: Partial<Record<ServiceName, Record<string, string | null>>>;
}

function request(stackUrl: string, method: string, path: string, options: CallOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] ??= 'application/json';
  }
  return fetch(`${stackUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) }).then(async (res) => {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  });
}

function makeReceiverCertificate(runDir: string): { certFile: string; keyFile: string } {
  const certFile = join(runDir, 'receiver-cert.pem');
  const keyFile = join(runDir, 'receiver-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  return { certFile, keyFile };
}

export async function startStack(options: StartOptions = {}): Promise<Stack> {
  const infra = options.infra ?? DEFAULT_INFRA;
  const names = (options.only ?? SERVICES).filter((n) => SERVICES.includes(n));
  const tolerate = options.tolerateFailures ?? true;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;

  if (existsSync(STATE_FILE)) throw new Error(`Ya hay un stack registrado en ${STATE_FILE}: corré \`yarn e2e:down\` (un solo stack a la vez).`);
  const missing = (await checkInfra(infra)).filter((c) => !c.ok);
  if (missing.length > 0) throw new Error(`Falta infraestructura del Compose: ${missing.map((m) => `${m.name} (${m.detail})`).join(', ')}. Levantala con \`docker compose -f platform/compose.yml up -d\`.`);

  const runId = `e2e${Date.now().toString(36)}`;
  const runDir = join(RUN_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  const ports = await freePorts(SERVICES.length + 2);
  const portOf = Object.fromEntries(SERVICES.map((n, i) => [n, ports[i]])) as Record<ServiceName, number>;
  const receiver = { port: ports[SERVICES.length], ...makeReceiverCertificate(runDir) };
  const secrets = generateSecrets();
  const kycDir = join(runDir, 'kyc');
  mkdirSync(kycDir, { recursive: true });
  const tbPort = ports[SERVICES.length + 1];
  const ctx: EnvContext = { runId, ports: portOf, infra: { ...infra, tigerbeetleAddress: `127.0.0.1:${tbPort}` }, secrets, receiverPort: receiver.port, receiverCaFile: receiver.certFile, kycDir, ...(options.webhookRetryScheduleMs ? { webhookRetryScheduleMs: options.webhookRetryScheduleMs } : {}) };

  const services = {} as Record<ServiceName, ServiceStatus>;
  for (const name of SERVICES) {
    services[name] = { name, port: portOf[name], url: `http://127.0.0.1:${portOf[name]}`, pid: undefined, started: false, healthy: false, error: names.includes(name) ? undefined : 'no pedido', logTail: undefined, logFile: join(runDir, `${name}.log`), startupMs: undefined };
  }
  const processes = new Map<ServiceName, Managed>();

  // Estado limpio: bases vacías con su DDL, sin streams heredados.
  await deleteServiceStreams(infra);
  await Promise.all(names.map((n) => resetDatabase(infra, n, true)));
  const tb = names.includes('pay-ledger') ? await startPrivateTigerBeetle(runDir, tbPort) : undefined;

  const stack: Stack = {
    runId,
    runDir,
    infra,
    secrets,
    services,
    processes,
    receiver,
    tigerbeetle: tb?.managed,
    url: (name) => services[name].url,
    call: (name, method, path, opts) => request(services[name].url, method, path, opts),
    callAs: (from, name, method, path, opts = {}) => {
      const { merchantId, payMode = 'test', ...rest } = opts;
      const headers: Record<string, string> = { 'x-service-id': from, ...(payMode ? { 'x-pay-mode': payMode } : {}), ...(merchantId ? { 'x-merchant-id': merchantId } : {}), ...rest.headers };
      return request(services[name].url, method, path, { ...rest, headers });
    },
  };

  writeFileSync(STATE_FILE, JSON.stringify({ runId, runDir, startedAt: new Date().toISOString(), pids: {}, ports: portOf, tigerbeetlePid: tb?.managed.pid }, null, 2));
  const persist = () =>
    writeFileSync(STATE_FILE, JSON.stringify({ runId, runDir, pids: Object.fromEntries([...processes].map(([n, p]) => [n, p.pid])), ports: portOf, tigerbeetlePid: tb?.managed.pid }, null, 2));

  const ready = new Set<ServiceName>();
  const attempted = new Set<ServiceName>();
  const startOne = async (name: ServiceName): Promise<void> => {
    const status = services[name];
    const started = Date.now();
    const env: Record<string, string> = { ...envFor(ctx, name) };
    for (const [key, value] of Object.entries(options.envOverrides?.[name] ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const managed = spawnNode(name, join(ROOT, 'services', name), 'dist/main.js', env, status.logFile);
    processes.set(name, managed);
    (status as { pid: number | undefined }).pid = managed.pid;
    persist();
    const outcome = await waitFor(
      async () => (await fetch(`${status.url}/health/ready`, { signal: AbortSignal.timeout(2000) })).status === 200,
      readyTimeoutMs,
      () => (managed.exit ? `el proceso terminó (código ${managed.exit.code ?? managed.exit.signal}) antes de quedar listo` : undefined),
    );
    status.startupMs = Date.now() - started;
    if (outcome.ok) {
      status.started = true;
      status.healthy = true;
      ready.add(name);
      return;
    }
    status.started = !managed.exit;
    status.error = outcome.reason;
    status.logTail = tailLog(status.logFile);
    // vivo pero no sano: se deja corriendo (puede ser una dependencia) y se informa; el cierre lo apaga
  };

  // Orden por dependencias: cada ola arranca a la vez lo que ya tiene a sus dependencias resueltas (sanas o definitivamente caídas).
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const wave = [...remaining].filter((n) => DEPENDS_ON[n].filter((d) => names.includes(d)).every((d) => attempted.has(d)));
    if (wave.length === 0) throw new Error('Ciclo de dependencias entre servicios');
    for (const n of wave) {
      remaining.delete(n);
      attempted.add(n);
    }
    await Promise.all(wave.map(startOne));
    if (!tolerate) {
      const failed = wave.find((n) => !services[n].healthy);
      if (failed) {
        await stopStack(stack);
        throw new Error(`${failed} no quedó sano: ${services[failed].error}\n${services[failed].logTail}`);
      }
    }
  }
  return stack;
}

export interface StopReport {
  readonly terminated: Record<string, string>;
  readonly streamsDeleted: string[];
  readonly databasesReset: string[];
  readonly tigerbeetleStopped: boolean;
  readonly leftoverPids: number[];
}

/** Apaga todo y deja la infraestructura como estaba: procesos, bases, streams. Nunca lanza por un proceso ya muerto. */
export async function stopStack(stack: Stack, options: { keepLogs?: boolean } = {}): Promise<StopReport> {
  const terminated: Record<string, string> = {};
  // Primero el borde y los que llaman; al final los que reciben.
  const order = [...stack.processes.keys()].reverse();
  await Promise.all(order.map(async (name) => (terminated[name] = await terminate(stack.processes.get(name)!))));
  const names = SERVICES.filter((n) => stack.services[n].error !== 'no pedido');
  await Promise.all(names.map((n) => resetDatabase(stack.infra, n, false)));
  const streamsDeleted = await deleteServiceStreams(stack.infra);
  let tigerbeetleStopped = false;
  if (stack.tigerbeetle) {
    await terminate(stack.tigerbeetle);
    tigerbeetleStopped = true;
    // el archivo de datos de TigerBeetle preasigna ~1 GiB: nunca se conserva
    rmSync(join(stack.runDir, '0_0.tigerbeetle'), { force: true });
    rmSync(join(stack.runDir, 'tigerbeetle'), { force: true });
  }
  const leftoverPids = [...stack.processes.values()].filter((p) => isOurProcess(p.pid, `services/${p.name}`)).map((p) => p.pid);
  if (stack.tigerbeetle && isOurProcess(stack.tigerbeetle.pid, 'pasarelapago')) leftoverPids.push(stack.tigerbeetle.pid);
  rmSync(STATE_FILE, { force: true });
  if (!options.keepLogs) {
    // los logs se conservan: son la evidencia; solo se borran el almacén de KYC y las claves temporales
    rmSync(join(stack.runDir, 'kyc'), { recursive: true, force: true });
    rmSync(stack.receiver.keyFile, { force: true });
  }
  return { terminated, streamsDeleted, databasesReset: names, tigerbeetleStopped, leftoverPids };
}

/** Limpia restos de un stack cuyo proceso de control murió: mata SOLO los PIDs registrados que sigan siendo servicios nuestros. */
export async function cleanupLeftovers(infra: Infra = DEFAULT_INFRA): Promise<{ killed: number[]; state: boolean }> {
  if (!existsSync(STATE_FILE)) return { killed: [], state: false };
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { runDir: string; pids: Record<string, number>; tigerbeetlePid?: number };
  const killed: number[] = [];
  for (const [name, pid] of Object.entries(state.pids)) {
    if (isOurProcess(pid, `services/${name}`)) {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    }
  }
  const deadline = Date.now() + 10_000;
  while (killed.some((pid) => isOurProcess(pid, 'services/')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of killed) if (isOurProcess(pid, 'services/')) process.kill(pid, 'SIGKILL');
  await Promise.all(SERVICES.map((n) => resetDatabase(infra, n, false)));
  await deleteServiceStreams(infra);
  if (state.tigerbeetlePid && isOurProcess(state.tigerbeetlePid, 'pasarelapago')) {
    process.kill(state.tigerbeetlePid, 'SIGTERM');
    const until = Date.now() + 10_000;
    while (isOurProcess(state.tigerbeetlePid, 'pasarelapago') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    if (isOurProcess(state.tigerbeetlePid, 'pasarelapago')) process.kill(state.tigerbeetlePid, 'SIGKILL');
  }
  rmSync(join(state.runDir, '0_0.tigerbeetle'), { force: true });
  rmSync(join(state.runDir, 'tigerbeetle'), { force: true });
  rmSync(STATE_FILE, { force: true });
  return { killed, state: true };
}
