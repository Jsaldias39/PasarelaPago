import { containsCardNumber } from './card-number';

/**
 * Ruta y atributos de URL SEGUROS para logs, el `instance` de los errores y los spans de OpenTelemetry. El cliente controla la URL: un segmento de ruta o la query
 * pueden traer un número de tarjeta (PAN), un NIT, una cédula (CI, con o sin complemento «-1A») o un nombre. Núcleo COMPARTIDO por todos los servicios.
 *
 * Solo se conservan los segmentos con forma de PALABRA de ruta (`payment_intents`, `cancel`, `health`: minúsculas y `_`, SIN dígitos) o de ID PROPIO de la
 * pasarela (prefijo conocido de los contratos + cuerpo alfanumérico de 8 a 64 con al menos una letra, y sin ningún PAN dentro); todo lo demás se enmascara como `:x`.
 * La query no se conserva nunca (regla 90.2.2).
 *
 * Un id propio con SEIS o más dígitos seguidos también se enmascara (un NIT o una cédula pegados a un prefijo conocido): cuesta ver en el log alrededor de 1 de cada 3
 * ids aleatorios, y es el compromiso que el servicio ya tenía (`pay-edge/test/log-safe.spec.ts`).
 * LÍMITE conocido: una palabra en minúsculas sin dígitos pasa tal cual (un nombre de persona escrito así en la URL no se enmascara).
 */
const WORD = /^(?:[a-z][a-z_]{0,40}|v[0-9]{1,2})$/; // `v1`, `v2`: la versión de la API es la única palabra de ruta con dígitos
/** Prefijos de id de los contratos (`contracts/openapi`, `contracts/asyncapi`): `^<prefijo>_[a-z0-9]{n,m}$`. */
const OWN_ID = /^(?:mc|pi|ch|re|key|tok|po|md|hd|we|sb|rx|rr|tr|ra|qr|cs|cr|tx|tf|sp|sl|kd|dp|cg|ca)_(?=[a-z0-9]*[a-z])[a-z0-9]{8,64}$/;

/** Seis o más dígitos seguidos (NIT, cédula, teléfono) dentro de un id propio: se enmascara. */
const LONG_DIGITS = /[0-9]{6,}/;

export function safeUrl(url: string): string {
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  return path
    .split('/')
    .map((segment) => (segment === '' || WORD.test(segment) || (OWN_ID.test(segment) && !containsCardNumber(segment) && !LONG_DIGITS.test(segment)) ? segment : ':x'))
    .join('/');
}

/** URL absoluta (`https://host/ruta?x`) o ruta: conserva el esquema y el host (sin credenciales ni puerto raro: lo que `URL` da como `host`) y enmascara la ruta. */
export function maskUrl(value: string): string {
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

/**
 * Atributos de span que llevan la RUTA (o la URL entera) de la petición. `url.*` es la convención estable de OpenTelemetry; `http.*`, la anterior que todavía
 * escriben varias instrumentaciones; `http.route` normalmente es la plantilla, pero con rutas comodín puede traer el valor real.
 */
export const URL_PATH_ATTRIBUTES: readonly string[] = ['url.path', 'url.full', 'url.original', 'http.target', 'http.url', 'http.route', 'http.path', 'http.request.target'];
/** Atributos que llevan la QUERY (`?documento=…`): jamás se conservan. */
export const URL_QUERY_ATTRIBUTES: readonly string[] = ['url.query', 'http.query', 'http.request.query'];

/**
 * Enmascara EN EL SITIO los atributos de URL de un span, justo antes de exportarlo: la ruta con {@link maskUrl}, la query con `[redacted]`. Cualquier OTRO atributo
 * `url.*` o `http.*` de tipo texto (cabeceras, agente de usuario…) que lleve un número de tarjeta también se redacta. Los demás atributos no se tocan.
 */
export function maskSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of URL_PATH_ATTRIBUTES) if (typeof attributes[key] === 'string') attributes[key] = maskUrl(attributes[key]);
  for (const key of URL_QUERY_ATTRIBUTES) if (key in attributes) attributes[key] = '[redacted]';
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' && /^(?:url|http)\./.test(key) && !URL_PATH_ATTRIBUTES.includes(key) && !URL_QUERY_ATTRIBUTES.includes(key) && containsCardNumber(value)) attributes[key] = '[redacted]';
  }
}
