import { HttpClient, UpstreamRejection, problemCode } from './upstream';

export interface TokenMetadata {
  readonly token: string;
  readonly brand: 'visa' | 'mastercard' | 'other';
  readonly last4: string;
  readonly exp_month: number;
  readonly exp_year: number;
  readonly fingerprint: string;
}

/**
 * Cliente de `internal/vault/v1`. pay-payments NUNCA recibe un número de tarjeta: solo consulta si un token existe y es del
 * comercio (metadatos: marca, últimos 4, vencimiento y huella). `reveal` lo llama únicamente pay-connectors.
 */
export class VaultClient {
  constructor(private readonly http: HttpClient) {}

  /** @returns Los metadatos, o `null` si el token no existe o es de otro comercio (el contrato responde 404 para ambos). */
  async getToken(token: string, merchantId: string): Promise<TokenMetadata | null> {
    const response = await this.http.request<TokenMetadata>({ method: 'GET', path: `/tokens/${token}`, headers: { 'x-merchant-id': merchantId } });
    if (response.status === 200) return response.body;
    if (response.status === 404) return null;
    throw new UpstreamRejection('pay-vault', response.status, problemCode(response.body));
  }
}
