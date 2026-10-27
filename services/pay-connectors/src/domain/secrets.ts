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

/** Cada conector solo puede pedir nombres de SU espacio (`CONNECTOR_<CODIGO>_…`): uno no lee los secretos de otro. */
export function namespaceOf(code: string): string {
  return `CONNECTOR_${code.toUpperCase()}_`;
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
