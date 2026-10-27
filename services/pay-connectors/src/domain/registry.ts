import type { Connector, ConnectorCode, Mode } from './connector';

/**
 * Registro de adaptadores. Es también la guardia de modo (D-26): con `PAY_MODE=live` un conector de sandbox
 * (el simulador `mock`) NO se puede registrar y el servicio no arranca.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorCode, Connector>();

  constructor(readonly mode: Mode) {}

  register(connector: Connector): this {
    if (this.connectors.has(connector.code)) throw new Error(`El conector ${connector.code} ya está registrado`);
    if (this.mode === 'live' && connector.mode === 'sandbox') {
      throw new Error(`El conector ${connector.code} es de sandbox y PAY_MODE=live: no se carga`);
    }
    if (this.mode === 'sandbox' && connector.mode === 'live') {
      throw new Error(`El conector ${connector.code} es de producción y PAY_MODE=sandbox: no se carga`);
    }
    this.connectors.set(connector.code, connector);
    return this;
  }

  has(code: ConnectorCode): boolean {
    return this.connectors.has(code);
  }

  get(code: ConnectorCode): Connector | undefined {
    return this.connectors.get(code);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }
}
