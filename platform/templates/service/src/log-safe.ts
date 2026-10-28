/**
 * Ruta segura para los logs: el cliente controla la URL, y un segmento de ruta puede traer un número de tarjeta o un nombre.
 * Solo se conservan segmentos con forma de nombre o de id (`charges`, `ch_abc…`, `mock`); lo demás se enmascara como `:x`.
 * Nunca se loguea la query (regla 90.2.2).
 */
export function safeUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .split('/')
    .map((segment) => (segment === '' || (/^[a-z][a-z0-9_-]{0,40}$/.test(segment) && !looksLikeNumber(segment)) ? segment : ':x'))
    .join('/');
}

/**
 * ¿Lleva un número largo (tarjeta, NIT, documento de identidad, teléfono)? Seis o más dígitos seguidos, o seguidos una vez quitados los separadores `-` y `_`
 * que se ponen ENTRE dígitos (`pan-4111-1111-1111-1111`, `nit-123-456-789`, `ci_1234_5678`): un segmento así NUNCA se conserva en un log, un `instance` ni un span.
 * Los ids de la pasarela (`pi_1a72d4…`) alternan letras y dígitos, no los tienen separados por `-`/`_` entre dos dígitos, y se siguen viendo.
 */
function looksLikeNumber(segment: string): boolean {
  return /\d{6,}/.test(segment.replace(/(?<=\d)[-_](?=\d)/g, ''));
}
