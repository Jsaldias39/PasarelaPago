/**
 * Secretos de los conectores. OpenBao es la meta (docs/spikes/openbao.md) pero no corre en el entorno de trabajo: el código
 * depende de esta interfaz y la implementación de desarrollo lee variables de entorno.
 *
 * Fail-closed: un secreto que no resuelve devuelve `[]` y quien verifica rechaza. Nunca hay un secreto por defecto.
 */
export interface SecretProvider {
  /** Secretos vigentes con ese nombre (más de uno SOLO durante una rotación). `[]` = no hay → rechazar. */
  getSecrets(name: string): Promise<readonly string[]>;
}

/** Un código de conector: minúsculas y dígitos en segmentos separados por UN guion bajo (`mock`, `mercantil_qr`). Sin guion bajo al borde ni doble. */
const CODE_SHAPE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Cada conector solo puede pedir nombres de SU espacio (`CONNECTOR_<CODIGO>_…`): uno no lee los secretos de otro.
 *
 * El guion bajo es a la vez delimitador del espacio y parte de los códigos y de los nombres de secreto, así que el prefijo solo aísla si NINGÚN código es prefijo de otro
 * delimitado por `_` (S-08): `mercantil` leería `CONNECTOR_MERCANTIL_QR_…` de `mercantil_qr`. Eso lo hace cumplir {@link assertNamespacesDisjoint}, que llama el registro.
 * @throws Error si el código no tiene la forma de un código de conector (no se arma un prefijo con un código arbitrario).
 */
export function namespaceOf(code: string): string {
  if (!CODE_SHAPE.test(code)) throw new Error(`Código de conector inválido para un espacio de secretos: ${JSON.stringify(code)}`);
  return `CONNECTOR_${code.toUpperCase()}_`;
}

/** ¿El espacio de `a` contiene al de `b` (o al revés)? Con el delimitador `_` incluido: `mercantil` contiene a `mercantil_qr`, pero `merc` NO contiene a `mercantil`. */
export function namespacesOverlap(a: string, b: string): boolean {
  const na = namespaceOf(a);
  const nb = namespaceOf(b);
  return na.startsWith(nb) || nb.startsWith(na);
}

/**
 * Ningún código puede ser prefijo (delimitado) de otro: si lo fuera, el proveedor acotado del primero resolvería los secretos del segundo. Lanza al registrar el segundo
 * conector, es decir, al arrancar. Una política de OpenBao por glob `CONNECTOR_<CODIGO>_*` tiene el mismo alcance, así que esto también protege las políticas.
 */
export function assertNamespacesDisjoint(existing: Iterable<string>, code: string): void {
  for (const other of existing) {
    if (other !== code && namespacesOverlap(code, other)) {
      throw new Error(`El conector ${code} comparte espacio de secretos con ${other} (uno es prefijo del otro con «_»): ${namespaceOf(code)}* alcanzaría ${namespaceOf(other)}…`);
    }
  }
}

/** [DEV] Lee `PAY_SECRET_<NOMBRE>` del entorno; admite una lista separada por comas para rotar sin corte. No es para producción. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSecrets(name: string): Promise<readonly string[]> {
    if (!/^CONNECTOR_[A-Z0-9_]+$/.test(name)) return [];
    const raw = this.env[`PAY_SECRET_${name}`];
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
}

/** Restringe un proveedor al espacio de nombres de un conector. */
export class ScopedSecretProvider implements SecretProvider {
  constructor(
    private readonly inner: SecretProvider,
    private readonly namespace: string,
  ) {}

  async getSecrets(name: string): Promise<readonly string[]> {
    return name.startsWith(this.namespace) ? this.inner.getSecrets(name) : [];
  }
}
