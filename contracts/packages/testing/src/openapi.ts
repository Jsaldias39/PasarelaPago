import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * Valida peticiones y respuestas reales contra un contrato OpenAPI de `contracts/openapi/`.
 * Es el «test de contrato» del gate de cada servicio: si el servicio responde algo que el contrato no promete
 * (o el contrato promete algo que el servicio no cumple), la prueba falla.
 */
export interface ContractValidator {
  /** Errores de una respuesta contra el contrato; lista vacía si cumple. */
  validateResponse(input: { method: string; path: string; status: number; body: unknown }): string[];
  /** Errores del cuerpo de una petición contra el contrato; lista vacía si cumple. */
  validateRequest(input: { method: string; path: string; body: unknown }): string[];
  /** Igual que `validateResponse`, pero lanza con un mensaje legible. */
  assertResponse(input: { method: string; path: string; status: number; body: unknown }): void;
  /** Operaciones del contrato: `METHOD /ruta/{plantilla}`. */
  operations(): string[];
}

type Json = Record<string, unknown>;

/** Quita `$id`/`$schema` de los subesquemas: tras desreferenciar, el mismo objeto aparece en varios sitios. */
function stripIds(node: unknown, seen = new Set<object>()): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  const record = node as Json;
  delete record.$id;
  delete record.$schema;
  for (const value of Object.values(record)) stripIds(value, seen);
}

function templateToRegExp(template: string): RegExp {
  const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`)).replace(/\{[^}]+\}/g, '[^/]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Carga y desreferencia un contrato.
 *
 * @param specPath - Ruta absoluta al YAML (por ejemplo `contracts/openapi/internal-ledger-v1.yaml`).
 */
export async function loadContract(specPath: string): Promise<ContractValidator> {
  const spec = (await $RefParser.dereference(specPath)) as Json;
  stripIds(spec);
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Json>>;
  // Las plantillas con más segmentos literales primero: `/a/b` gana a `/a/{id}`.
  const templates = Object.keys(paths).sort((a, b) => (b.match(/\{/g)?.length ?? 0) - (a.match(/\{/g)?.length ?? 0)).reverse();
  const matchers = templates.map((template) => ({ template, regexp: templateToRegExp(template) }));

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const cache = new Map<object, ValidateFunction>();
  const compile = (schema: object): ValidateFunction => {
    let validate = cache.get(schema);
    if (!validate) {
      validate = ajv.compile(schema);
      cache.set(schema, validate);
    }
    return validate;
  };

  const find = (method: string, path: string): { template: string; operation: Json } | string => {
    const clean = path.split('?')[0].replace(/\/+$/, '') || '/';
    const hit = matchers.find((m) => m.regexp.test(clean) && paths[m.template][method.toLowerCase()]);
    if (!hit) return `El contrato no define ${method.toUpperCase()} ${clean}`;
    return { template: hit.template, operation: paths[hit.template][method.toLowerCase()] };
  };

  const describe = (validate: ValidateFunction): string[] =>
    (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`);

  const validateResponse: ContractValidator['validateResponse'] = ({ method, path, status, body }) => {
    const found = find(method, path);
    if (typeof found === 'string') return [found];
    const responses = (found.operation.responses ?? {}) as Record<string, Json>;
    const response = responses[String(status)] ?? responses.default;
    if (!response) return [`${method.toUpperCase()} ${found.template} no declara la respuesta ${status}`];
    const content = (response.content ?? {}) as Record<string, { schema?: object }>;
    const media = Object.values(content)[0];
    if (!media?.schema) return []; // sin cuerpo declarado (por ejemplo 204)
    const validate = compile(media.schema);
    return validate(body) ? [] : describe(validate);
  };

  const validateRequest: ContractValidator['validateRequest'] = ({ method, path, body }) => {
    const found = find(method, path);
    if (typeof found === 'string') return [found];
    const requestBody = found.operation.requestBody as { content?: Record<string, { schema?: object }> } | undefined;
    const media = requestBody?.content ? Object.values(requestBody.content)[0] : undefined;
    if (!media?.schema) return [];
    const validate = compile(media.schema);
    return validate(body) ? [] : describe(validate);
  };

  return {
    validateResponse,
    validateRequest,
    assertResponse(input) {
      const errors = validateResponse(input);
      if (errors.length > 0) {
        throw new Error(`La respuesta ${input.status} de ${input.method.toUpperCase()} ${input.path} no cumple el contrato:\n  - ${errors.join('\n  - ')}`);
      }
    },
    operations() {
      return templates.flatMap((t) => Object.keys(paths[t]).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${t}`));
    },
  };
}
