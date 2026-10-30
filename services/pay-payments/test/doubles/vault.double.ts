import { CONTRACTS } from './contracts';
import { DoubleServer, problem, type DoubleRequest, type DoubleResponse } from './server';

/** [DOBLE] de pay-vault: solo la parte que consume pay-payments (`GET /tokens/{token}`). Nunca maneja un número de tarjeta. */
export class VaultDouble {
  /** token → comercio dueño. Los tokens son por comercio: el de otro comercio responde 404. */
  readonly tokens = new Map<string, string>();
  readonly server: DoubleServer;

  constructor() {
    this.server = new DoubleServer(CONTRACTS.vault, (req) => this.handle(req));
  }
  start = () => this.server.start();
  stop = () => this.server.stop();

  private handle(req: DoubleRequest): DoubleResponse {
    const match = /^\/tokens\/(tok_[a-z0-9]{10,60})$/.exec(req.path);
    if (req.method !== 'GET' || !match) return problem('resource_not_found', 404);
    const owner = this.tokens.get(match[1]);
    if (!owner || owner !== req.headers['x-merchant-id']) return problem('resource_not_found', 404);
    return {
      status: 200,
      body: { token: match[1], object: 'card_token', brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030, fingerprint: 'fp_synthetic_0001', single_use: true, created_at: new Date().toISOString() },
    };
  }
}
