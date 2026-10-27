import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

type Json = Record<string, unknown>;

function strip(node: unknown, seen = new Set<object>()): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  const record = node as Json;
  delete record.$id;
  delete record.$schema;
  for (const value of Object.values(record)) strip(value, seen);
}

export interface EventContract {
  /** Errores del evento contra el contrato de ese canal; lista vacía si cumple. */
  validate(subject: string, event: unknown): string[];
  /** Los temas (direcciones de canal) que define el contrato. */
  subjects(): string[];
}

/**
 * Valida un evento emitido contra el AsyncAPI de `contracts/asyncapi/`: el canal sale del `subject` NATS (la dirección del
 * canal) y el sobre completo (CloudEvents + `data`) se compila con Ajv. Es el «test de contrato» de los productores de eventos.
 *
 * @param asyncApiFile - Ruta del archivo AsyncAPI (por ejemplo `contracts/asyncapi/payments.yaml`).
 */
export async function loadEventContract(asyncApiFile: string): Promise<EventContract> {
  const doc = (await $RefParser.dereference(asyncApiFile)) as Json;
  strip(doc);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const bySubject = new Map<string, ValidateFunction>();
  for (const channel of Object.values((doc.channels ?? {}) as Record<string, Json>)) {
    const message = Object.values((channel.messages ?? {}) as Record<string, Json>)[0];
    if (message?.payload) bySubject.set(channel.address as string, ajv.compile(message.payload as object));
  }
  return {
    subjects: () => [...bySubject.keys()],
    validate(subject, event) {
      const validate = bySubject.get(subject);
      if (!validate) return [`El contrato no define el canal ${subject}`];
      return validate(event) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
    },
  };
}
