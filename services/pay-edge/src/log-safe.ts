/**
 * Ruta segura para los logs, el `instance` de los errores y los spans: el cliente controla la URL y un segmento puede traer un número de tarjeta, un NIT o una
 * cédula. La implementación es COMPARTIDA (`@pay/idempotency`, `url-mask.ts`, con sus pruebas); se re-exporta acá para que los imports del servicio no cambien.
 */
export { safeUrl } from '@pay/idempotency';
