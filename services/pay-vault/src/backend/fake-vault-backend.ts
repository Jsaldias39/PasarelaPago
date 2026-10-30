import { createHmac, randomBytes } from 'node:crypto';
import type { CaptureState, CardData, CardMetadata, VaultBackend } from './vault-backend';

/** Luhn: el formulario alojado real rechaza un número que no lo cumple. */
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const brandOf = (pan: string): CardMetadata['brand'] => {
  if (pan.startsWith('4')) return 'visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|[3-6]\d\d|7[01]\d|720))/.test(pan)) return 'mastercard';
  return 'other';
};

interface Session {
  merchantId: string;
  saveCard: boolean;
  expiresAt: Date;
  status: 'open' | 'completed' | 'expired' | 'canceled';
  token?: string;
  card?: CardMetadata;
}

/**
 * [DOBLE] de `VaultBackend`. NO es una bóveda: guarda la tarjeta en MEMORIA del proceso de pruebas y la entrega tal cual.
 * Sirve para ejercitar pay-vault (sesiones, tokens por comercio, reveal auditado) sin un tercero. `completeCapture` hace de
 * formulario alojado: es lo que en producción hace el pagador tecleando la tarjeta en la página del backend real.
 * Nunca debe estar disponible con `PAY_MODE=live` (lo impide la configuración).
 */
export class FakeVaultBackend implements VaultBackend {
  private readonly sessions = new Map<string, Session>();
  private readonly cards = new Map<string, CardData & { fingerprint: string }>();
  private readonly hmacKey = randomBytes(32);
  /** Para forzar la caída del backend en pruebas. */
  failNext = 0;

  async openCapture(input: { sessionId: string; merchantId: string; saveCard: boolean; expiresAt: Date }): Promise<{ captureUrl: string }> {
    this.maybeFail();
    if (!this.sessions.has(input.sessionId)) this.sessions.set(input.sessionId, { merchantId: input.merchantId, saveCard: input.saveCard, expiresAt: input.expiresAt, status: 'open' });
    return { captureUrl: `https://vault-backend.example.test/capture/${input.sessionId}` };
  }

  async getCapture(sessionId: string): Promise<CaptureState> {
    this.maybeFail();
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'canceled' };
    if (session.status === 'open' && session.expiresAt.getTime() < Date.now()) session.status = 'expired';
    if (session.status === 'completed' && session.token && session.card) return { status: 'completed', token: session.token, card: session.card };
    return { status: session.status === 'completed' ? 'canceled' : session.status };
  }

  async reveal(token: string): Promise<CardData | null> {
    this.maybeFail();
    const card = this.cards.get(token);
    return card ? { number: card.number, expMonth: card.expMonth, expYear: card.expYear, holderName: card.holderName } : null;
  }

  async delete(token: string): Promise<void> {
    this.maybeFail();
    this.cards.delete(token);
  }

  /** El pagador teclea la tarjeta en el formulario alojado. El CVV se valida y se DESCARTA: nunca se almacena. */
  completeCapture(sessionId: string, card: { number: string; expMonth: number; expYear: number; cvv: string; holderName?: string }): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'open') throw new Error('sesión de captura no abierta');
    const digits = card.number.replace(/[ -]/g, '');
    if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) throw new Error('número de tarjeta inválido');
    if (!/^\d{3,4}$/.test(card.cvv)) throw new Error('cvv inválido');
    const token = `tok_${randomBytes(12).toString('hex')}`;
    const fingerprint = createHmac('sha256', this.hmacKey).update(digits).digest('hex').slice(0, 32);
    this.cards.set(token, { number: digits, expMonth: card.expMonth, expYear: card.expYear, holderName: card.holderName ?? null, fingerprint });
    session.status = 'completed';
    session.token = token;
    session.card = { brand: brandOf(digits), last4: digits.slice(-4), expMonth: card.expMonth, expYear: card.expYear, fingerprint };
    return token;
  }

  has(token: string): boolean {
    return this.cards.has(token);
  }

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('backend de bóveda caído');
    }
  }
}
