import { readFileSync } from 'node:fs';
import { Parser } from '@asyncapi/parser';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { repoPath } from './app';

/** Quita lo que el parser agrega (`x-parser-*`) y los `$id`/`$schema` repetidos del sobre, que Ajv no admite duplicados. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => k !== '$schema' && k !== '$id' && !k.startsWith('x-parser-'))
        .map(([k, v]) => [k, strip(v)]),
    );
  }
  return node;
}

export type EventValidator = (event: unknown) => string[];

/** Un validador por tipo de evento (`ledger.transfer.posted`…), compilado desde el AsyncAPI real del contrato. */
export async function loadEventValidators(asyncApiFile: string): Promise<Map<string, EventValidator>> {
  const path = repoPath('contracts/asyncapi', asyncApiFile);
  const { document } = await new Parser().parse(readFileSync(path, 'utf8'), { source: path });
  if (!document) throw new Error(`No se pudo leer ${asyncApiFile}`);
  const out = new Map<string, EventValidator>();
  for (const message of document.allMessages().all()) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(strip(message.payload()?.json()) as object);
    out.set(String(message.name()), (event) => (validate(event) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)));
  }
  return out;
}
