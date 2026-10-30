/**
 * Propietario de los endpoints que este servicio crea en Svix (REVISION-DINERO F2).
 *
 * Svix puede ser compartido (sandbox y live apuntados al mismo servidor, o una base de este servicio restaurada desde un respaldo): sin una
 * marca de propietario, el reconciliador no puede distinguir «un alta que se revirtió» de «un endpoint legítimo de otro entorno» y borraría los dos
 * (borrar es irreversible: el secreto del comercio se pierde con el endpoint). Cada endpoint se crea con
 * `metadata.pay_owner = <WEBHOOKS_SVIX_NAMESPACE>` y el reconciliador solo considera huérfanos los que llevan SU marca.
 *
 * La marca va en los METADATOS del endpoint y no en su `uid`: el `uid` (`we_…`) es la clave con la que se rota, se deshabilita, se consultan
 * intentos y se borra cada endpoint (también los que ya existen); cambiarlo obligaría a resolver cada operación contra dos formas de `uid`.
 * Migración: los endpoints anteriores a esta marca no la tienen y NO se borran nunca (quedan fuera del alcance del reconciliador).
 */
export const SVIX_OWNER_KEY = 'pay_owner';

/** Valor por defecto SOLO en sandbox. Bajo `live` la variable es obligatoria y no puede ser este valor. */
export const DEFAULT_SANDBOX_NAMESPACE = 'sandbox';

export const SVIX_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function assertValidNamespace(value: string): string {
  if (!SVIX_NAMESPACE_PATTERN.test(value)) throw new RangeError('El espacio de nombres de Svix debe cumplir /^[a-z0-9][a-z0-9-]{1,31}$/');
  return value;
}
