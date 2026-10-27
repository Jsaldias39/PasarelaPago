import { readFileSync } from 'node:fs';
import { Parser } from '@asyncapi/parser';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ASYNCAPI_PAYMENTS } from '../doubles/contracts';

/** Quita lo que el parser agrega (`x-parser-*`) y los `$id`/`$schema` repetidos del sobre. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => k !== '$schema' && k !== '$id' && !k.startsWith('x-parser-')).map(([k, v]) => [k, strip(v)]));
  }
  return node;
}

export type EventValidator = (event: unknown) => string[];

/** Un validador por tipo de evento (`payment_intent.succeeded`…), compilado desde el AsyncAPI REAL de `contracts/asyncapi/`. */
export async function loadEventValidators(file: string = ASYNCAPI_PAYMENTS): Promise<Map<string, EventValidator>> {
  const { document } = await new Parser().parse(readFileSync(file, 'utf8'), { source: file });
  if (!document) throw new Error(`No se pudo leer ${file}`);
  const out = new Map<string, EventValidator>();
  for (const message of document.allMessages().all()) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(strip(message.payload()?.json()) as object);
    out.set(String(message.name()), (event) => (validate(event) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)));
  }
  return out;
}
