import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicIp } from './ip-policy';

/** Resuelve un nombre a TODAS sus direcciones (A y AAAA). Se inyecta para poder probar el rebinding. */
export interface Resolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export class DnsResolver implements Resolver {
  async resolve(hostname: string): Promise<readonly string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  }
}

export type TargetRejection =
  | 'invalid_url'
  | 'https_required'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'internal_name'
  | 'private_address'
  | 'unresolvable';

/** El destino no es una URL pública permitida. `reason` es estable y no revela nada de la red interna. */
export class TargetRejectedError extends Error {
  constructor(readonly reason: TargetRejection) {
    super(`Destino rechazado: ${reason}`);
    this.name = 'TargetRejectedError';
  }
}

export interface ResolvedTarget {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  /** La dirección PÚBLICA a la que hay que conectar. El nombre solo sirve para SNI, certificado y cabecera Host. */
  readonly ip: string;
  readonly family: 4 | 6;
}

export interface TargetGuardOptions {
  readonly allowedPorts?: readonly number[];
  /** Sufijos de nombres internos que se rechazan sin resolver (además de los nombres sin punto). */
  readonly internalSuffixes?: readonly string[];
  /** SOLO sandbox: pares `host:puerto` exactos que se aceptan sin las comprobaciones de red privada (el receptor local del e2e). */
  readonly allowTargets?: ReadonlySet<string>;
}

const DEFAULT_INTERNAL_SUFFIXES = [
  '.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private',
  '.svc', '.cluster.local', '.consul', '.docker', '.test.pay',
] as const;

/**
 * Valida un destino de webhook y lo resuelve a una IP pública fijada. Se llama al registrar Y en CADA entrega: un nombre que
 * resolvía a una IP pública al registrarse puede apuntar a una privada después (DNS rebinding).
 *
 * Reglas (todas, en este orden): URL interpretable; esquema `https`; sin usuario ni contraseña; puerto permitido (443 por
 * defecto); nombre que no sea interno (sin punto, `localhost`, sufijos internos); si es una IP literal, pública; el nombre
 * resuelve a al menos una dirección y **todas** son públicas (una sola privada basta para rechazar: el cliente podría usarla).
 */
export class TargetGuard {
  private readonly allowedPorts: readonly number[];
  private readonly internalSuffixes: readonly string[];
  private readonly allowTargets: ReadonlySet<string>;

  constructor(
    private readonly resolver: Resolver,
    options: TargetGuardOptions = {},
  ) {
    this.allowedPorts = options.allowedPorts ?? [443];
    this.internalSuffixes = options.internalSuffixes ?? DEFAULT_INTERNAL_SUFFIXES;
    this.allowTargets = options.allowTargets ?? new Set();
  }

  async check(rawUrl: string): Promise<ResolvedTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new TargetRejectedError('invalid_url');
    }
    if (url.protocol !== 'https:') throw new TargetRejectedError('https_required');
    if (url.username !== '' || url.password !== '') throw new TargetRejectedError('credentials_in_url');
    const port = url.port === '' ? 443 : Number(url.port);
    const exact = `${url.hostname}:${port}`;
    if (this.allowTargets.has(exact)) return { hostname: url.hostname, port, path: `${url.pathname}${url.search}`, ip: url.hostname, family: 4 };
    if (!this.allowedPorts.includes(port)) throw new TargetRejectedError('port_not_allowed');

    // WHATWG URL ya normaliza 2130706433, 0x7f.1, 0177.0.0.1 y [::ffff:7f00:1] a su forma canónica antes de llegar acá.
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (hostname === '') throw new TargetRejectedError('invalid_url');

    const path = `${url.pathname}${url.search}`;
    const literal = isIP(hostname);
    if (literal !== 0) {
      if (!isPublicIp(hostname)) throw new TargetRejectedError('private_address');
      return { hostname, port, path, ip: hostname, family: literal as 4 | 6 };
    }

    if (!hostname.includes('.') || hostname === 'localhost' || this.internalSuffixes.some((suffix) => hostname.endsWith(suffix))) {
      throw new TargetRejectedError('internal_name');
    }

    let addresses: readonly string[];
    try {
      addresses = await this.resolver.resolve(hostname);
    } catch {
      throw new TargetRejectedError('unresolvable');
    }
    if (addresses.length === 0) throw new TargetRejectedError('unresolvable');
    if (!addresses.every(isPublicIp)) throw new TargetRejectedError('private_address');
    return { hostname, port, path, ip: addresses[0], family: isIP(addresses[0]) as 4 | 6 };
  }
}
