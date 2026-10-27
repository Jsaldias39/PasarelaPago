import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { deleteServiceStreams, makeReceiverCertificate, resetDatabase, ROOT, startPrivateTigerBeetle } from './infra.ts';
import { freePorts, spawnNode, tailLog, terminate, waitFor } from './process.ts';
import { DEFAULT_INFRA, envFor, generateSecrets, SERVICES, type EnvContext, type ServiceName } from './services.ts';

export type ProbeOutcome = 'arranca' | 'falla_rapido' | 'vivo_no_sano';

export interface EnvProbeRow {
  readonly service: ServiceName;
  readonly variable: string;
  readonly outcome: ProbeOutcome;
  readonly detail: string | undefined;
}

/**
 * Qué variables son OBLIGATORIAS de verdad: arranca cada servicio solo, con su entorno completo menos UNA variable por vez, y mira si
 * el proceso sale (falla al arrancar, como pide la regla 90.3.4) o arranca igual (la variable es opcional o tiene un valor por defecto).
 * Los servicios corren en paralelo entre sí y en serie dentro de cada uno (cada uno usa su puerto). `PORT` no se prueba.
 */
export async function probeEnv(options: { concurrency?: number; perBootTimeoutMs?: number } = {}): Promise<EnvProbeRow[]> {
  const infra = DEFAULT_INFRA;
  const runId = `probe${Date.now().toString(36)}`;
  const ports = await freePorts(SERVICES.length + 2);
  const portOf = Object.fromEntries(SERVICES.map((n, i) => [n, ports[i]])) as Record<ServiceName, number>;
  const infraWithTb = { ...infra, tigerbeetleAddress: `127.0.0.1:${ports[SERVICES.length + 1]}` };
  const ctx: EnvContext = { runId, ports: portOf, infra: infraWithTb, secrets: generateSecrets(), receiverPort: ports[SERVICES.length], receiverCaFile: join(ROOT, 'e2e/.run', runId, 'receiver-cert.pem'), kycDir: join(ROOT, 'e2e/.run', runId, 'kyc') };
  await deleteServiceStreams(infra);
  await Promise.all(SERVICES.map((n) => resetDatabase(infra, n, true)));
  const runDir = join(ROOT, 'e2e/.run', runId);
  mkdirSync(runDir, { recursive: true });
  makeReceiverCertificate(runDir);
  const tb = await startPrivateTigerBeetle(runDir, ports[SERVICES.length + 1]);
  const rows: EnvProbeRow[] = [];
  const timeout = options.perBootTimeoutMs ?? 20_000;

  const probeService = async (name: ServiceName) => {
    const full = envFor(ctx, name);
    for (const variable of Object.keys(full).filter((v) => v !== 'PORT')) {
      const env = { ...full };
      delete env[variable];
      const logFile = join(ROOT, 'e2e/.run', runId, `${name}.${variable}.log`);
      const managed = spawnNode(name, join(ROOT, 'services', name), 'dist/main.js', env, logFile);
      const result = await waitFor(
        async () => (await fetch(`http://127.0.0.1:${portOf[name]}/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200,
        timeout,
        () => (managed.exit ? 'salió' : undefined),
      );
      const outcome: ProbeOutcome = result.ok ? 'arranca' : managed.exit ? 'falla_rapido' : 'vivo_no_sano';
      const tail = outcome === 'arranca' ? undefined : tailLog(logFile, 3).split('\n').map((l) => l.replace(/\{"level":\d+,"time":\d+,"pid":\d+,"hostname":"[^"]*",?/, '').slice(0, 200)).join(' | ');
      await terminate(managed, 8000);
      rows.push({ service: name, variable, outcome, detail: tail });
    }
  };

  try {
    const queue = [...SERVICES];
    const workers = Array.from({ length: options.concurrency ?? 4 }, async () => {
      for (let name = queue.shift(); name; name = queue.shift()) await probeService(name);
    });
    await Promise.all(workers);
  } finally {
    await Promise.all(SERVICES.map((n) => resetDatabase(infra, n, false)));
    await deleteServiceStreams(infra);
    await terminate(tb.managed);
    rmSync(tb.dataFile, { force: true });
    rmSync(join(runDir, 'tigerbeetle'), { force: true });
  }
  return rows.sort((a, b) => a.service.localeCompare(b.service) || a.variable.localeCompare(b.variable));
}
