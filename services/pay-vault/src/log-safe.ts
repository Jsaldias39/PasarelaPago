import { containsPan } from './redact';

/**
 * Ruta segura para los logs, el `instance` de los errores y los spans: el cliente controla la URL y un segmento puede traer un número de
 * tarjeta, un NIT o una cédula (CI, con o sin complemento «-1A»). Solo se conservan los segmentos con forma de PALABRA de ruta (`payment_intents`,
 * `cancel`, `health`) o de ID PROPIO con prefijo conocido y al menos una letra (`pi_ab12…`, `tok_…`); todo lo demás se enmascara como `:x`.
 * La query no se conserva nunca (regla 90.2.2).
 *
 * Límite conocido: una palabra en minúsculas, sin dígitos, pasa tal cual (un nombre de persona escrito así en la URL no se enmascara).
 */
const WORD = /^[a-z][a-z_]{0,40}$/;
const OWN_ID = /^(?:pi|re|dp|mc|cs|tok|ch|cr|tx|hd)_(?=[a-z0-9]*[a-z])[a-z0-9]{8,64}$/;

export function safeUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .split('/')
    .map((segment) => (segment === '' || WORD.test(segment) || (OWN_ID.test(segment) && !containsPan(segment)) ? segment : ':x'))
    .join('/');
}
