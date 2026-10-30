import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'nats';
import { Client } from 'pg';
import type { Stack } from '../stack.ts';
import { ALL_SERVICES } from './services.ts';
import type { ScanSource } from './pan-scan.ts';

/**
 * Fuentes que E7 escanea en busca de un PAN: logs de todos los procesos, TODO lo que pasó por el bus, TODAS las filas de las bases de todos los servicios y los historiales de
 * Temporal. Cada fuente devuelve el texto y cuántos elementos miró (`items`), para que la prueba pueda exigir que el escaneo NO fue vacío.
 * Las trazas (colector OTLP del arnés) están en otlp-sink.ts. Todo es solo de lectura; los hallazgos salen enmascarados (pan-scan.ts).
 */
export interface CollectedSource extends ScanSource {
  readonly items: number;
}

/** Los `.log` de cada proceso del stack (stdout+stderr de los servicios y el de TigerBeetle). Los servicios que no se pidieron no tienen archivo. */
export function logSources(stack: Stack): CollectedSource[] {
  const files = [...ALL_SERVICES.map((name) => stack.services[name]?.logFile), stack.tigerbeetle?.logFile].filter((f): f is string => typeof f === 'string' && existsSync(f));
  return files.map((file) => {
    const text = readFileSync(file, 'utf8');
    return { source: `log:${file.split('/').pop()}`, text, items: text === '' ? 0 : text.split('\n').length };
  });
}

/** Todos los mensajes (datos y cabeceras) de todos los streams de JetStream con mensajes. */
export async function busSources(stack: Stack): Promise<CollectedSource[]> {
  const nc = await connect({ servers: stack.infra.natsUrl, name: 'e2e-pan-scan' });
  try {
    const jsm = await nc.jetstreamManager();
    const out: CollectedSource[] = [];
    for await (const info of jsm.streams.list()) {
      const stream = info.config.name;
      if (!stream.startsWith('PAY_') || info.state.messages === 0) continue;
      const consumer = await jsm.consumers.add(stream, { ack_policy: 'none' as never, deliver_policy: 'all' as never, inactive_threshold: 30_000_000_000 });
      try {
        const reader = await nc.jetstream().consumers.get(stream, consumer.name);
        let read = 0;
        const parts: string[] = [];
        while (read < info.state.messages) {
          const batch = await reader.fetch({ max_messages: 500, expires: 1_000 });
          let got = 0;
          for await (const message of batch) {
            got += 1;
            const headers: string[] = [];
            for (const key of message.headers?.keys() ?? []) headers.push(`${key}=${(message.headers?.values(key) ?? []).join(',')}`);
            parts.push(`${message.subject}\n${headers.join('\n')}\n${message.string()}`);
          }
          read += got;
          if (got === 0) break;
        }
        out.push({ source: `nats:${stream}`, text: parts.join('\n---\n'), items: parts.length });
      } finally {
        await jsm.consumers.delete(stream, consumer.name).catch(() => undefined);
      }
    }
    return out;
  } finally {
    await nc.close();
  }
}

/** Todas las filas de todas las tablas de la base de cada servicio del stack, como texto (`row::text`, que incluye jsonb y bytea). Lectura con el usuario administrador del Compose. */
export async function databaseSources(stack: Stack): Promise<CollectedSource[]> {
  const out: CollectedSource[] = [];
  for (const name of ALL_SERVICES) {
    if (!stack.services[name]?.started) continue;
    const database = `pay_${name.replace('pay-', '')}`;
    const client = new Client({ connectionString: `${stack.infra.postgres.adminUrl}/${database}` });
    await client.connect();
    try {
      const tables = (await client.query("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2")).rows as { s: string; t: string }[];
      for (const { s, t } of tables) {
        const rows = (await client.query(`SELECT x::text AS r FROM "${s}"."${t}" x`)).rows as { r: string }[];
        out.push({ source: `db:${database}.${s}.${t}`, text: rows.map((r) => r.r).join('\n'), items: rows.length });
      }
    } finally {
      await client.end();
    }
  }
  return out;
}

/**
 * Campos del historial que identifican al WORKER (hash de su bundle), no son datos: un hash hexadecimal de 64 caracteres puede llevar, por azar, una tira de 13 a 19 dígitos que
 * cumple Luhn y empieza como una marca, y el detector la tomaría por un PAN (pasó cuando se recompiló el workflow: 15 dígitos «3529…» dentro de `buildId`). Los PAYLOADS
 * (entradas, resultados, memo, cabeceras, detalles de fallo) se siguen leyendo enteros.
 */
export const WORKER_IDENTITY_KEYS: ReadonlySet<string> = new Set(['buildId', 'binaryChecksum']);

/** El historial como texto para el escaneo: los bytes de cada payload como texto, sin las claves de identidad del worker. */
export function historyText(history: unknown): string {
  return JSON.stringify(history, (key, value: unknown) => {
    if (WORKER_IDENTITY_KEYS.has(key)) return '[identidad-del-worker]';
    return value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value;
  });
}

/** Historiales de los workflows de Temporal indicados (los payloads de las actividades). Los bytes de cada payload se leen como texto. */
export async function temporalSources(stack: Stack, workflowIds: readonly string[]): Promise<CollectedSource[]> {
  const { Client: TemporalClient, Connection } = await import('@temporalio/client');
  const connection = await Connection.connect({ address: stack.infra.temporalAddress });
  try {
    const client = new TemporalClient({ connection, namespace: 'default' });
    const out: CollectedSource[] = [];
    for (const id of workflowIds) {
      const history = await client.workflow.getHandle(id).fetchHistory();
      const text = historyText(history);
      out.push({ source: `temporal:${id}`, text, items: history.events?.length ?? 0 });
    }
    return out;
  } finally {
    await connection.close();
  }
}
