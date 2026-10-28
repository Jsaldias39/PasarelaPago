/**
 * Ruta segura para los logs: el cliente controla la URL, y un segmento de ruta puede traer un número de tarjeta o un nombre.
 * Solo se conservan segmentos con forma de nombre o de id (`charges`, `ch_abc…`, `mock`); lo demás se enmascara como `:x`.
 * Nunca se loguea la query (regla 90.2.2).
 */
export function safeUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .split('/')
    .map((segment) => (segment === '' || (/^[a-z][a-z0-9_-]{0,40}$/.test(segment) && !/\d{6,}/.test(segment)) ? segment : ':x'))
    .join('/');
}
