import { safeUrl } from '../log-safe';

/**
 * Regla 90.2: la URL la controla el cliente y puede traer un número de tarjeta, un documento o un nombre (en la ruta o en la query). Un span NO guarda
 * la URL cruda: se reemplaza por la misma versión segura que usan los logs (segmentos con forma de id o de nombre; nunca la query).
 * Se aplica a TODOS los spans justo antes de exportarlos, vengan de la instrumentación que vengan (http, express, nestjs, pg).
 * Prueba: docs/trabajo/ola-3/P4/scripts/sensitive-data-scan.mjs (lee lo que realmente exportó OpenTelemetry) y `test/scrub.spec.ts`.
 */
const URL_KEYS = ['http.target', 'http.url', 'url.full', 'url.path', 'http.path'] as const;

export function scrubUrl(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${safeUrl(url.pathname)}`;
    } catch {
      return ':x';
    }
  }
  return safeUrl(value);
}

/** Reemplaza en el sitio los atributos de URL de un span. Los demás no se tocan. */
export function scrubSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of URL_KEYS) {
    const value = attributes[key];
    if (typeof value === 'string') attributes[key] = scrubUrl(value);
  }
  if ('url.query' in attributes) attributes['url.query'] = '';
}
