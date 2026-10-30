import { join } from 'node:path';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Pool } from 'pg';
import { REPO } from './app';

type Json = Record<string, unknown>;

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === '$schema' || k === '$id') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}

/** Valida los sobres del outbox contra los mensajes del AsyncAPI de P4 (`contracts/asyncapi/connectors.yaml`). */
export async function loadEventValidator(): Promise<(message: string, envelope: unknown) => string[]> {
  const doc = (await $RefParser.dereference(join(REPO, 'contracts/asyncapi/connectors.yaml'))) as Json;
  const messages = (doc.components as Json).messages as Record<string, Json>;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const [name, message] of Object.entries(messages)) compiled.set(name, ajv.compile(strip(message.payload) as Json));
  return (message, envelope) => {
    const validate = compiled.get(message);
    if (!validate) throw new Error(`Mensaje desconocido: ${message}`);
    return validate(envelope) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
  };
}

export const MESSAGES = {
  status: 'ConnectorTransactionStatusChanged',
  degraded: 'ConnectorHealthDegraded',
  recovered: 'ConnectorHealthRecovered',
  transfer: 'ConnectorTransferStatusChanged',
} as const;

/** Eventos del outbox, del más viejo al más nuevo. */
export async function outboxEvents(pool: Pool, type?: string): Promise<Array<{ envelope: Json; published_at: Date | null }>> {
  const rows = await pool.query(`SELECT envelope, published_at FROM outbox_events ${type ? 'WHERE type = $1' : ''} ORDER BY seq`, type ? [type] : []);
  return rows.rows as Array<{ envelope: Json; published_at: Date | null }>;
}
