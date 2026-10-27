import { Webhook } from 'standardwebhooks';
import {
  generateKeyPair,
  generateSecret,
  sign,
  signedHeaders,
  verify,
  WebhookVerificationError,
} from './index';

const payload = JSON.stringify({ type: 'payment_intent.succeeded', timestamp: '2026-10-27T15:00:00Z', data: { id: 'pi_1', amount_minor: 10000 } });
const NOW = 1_800_000_000;
const id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';

function failure(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('webhook-signature (Standard Webhooks v1/v1a)', () => {
  const secret = generateSecret();

  describe('v1 contra la librería de referencia `standardwebhooks`', () => {
    it('nuestra firma es idéntica a la de la referencia, byte a byte', () => {
      const reference = new Webhook(secret);
      const expected = reference.sign(id, new Date(NOW * 1000), payload);
      expect(sign({ id, timestamp: NOW, payload, secrets: [secret] })).toBe(expected);
    });

    it('la referencia verifica lo que nosotros firmamos', () => {
      const headers = signedHeaders({ id, timestamp: Math.floor(Date.now() / 1000), payload, secrets: [secret] });
      expect(() => new Webhook(secret).verify(payload, headers)).not.toThrow();
    });

    it('nosotros verificamos lo que firma la referencia', () => {
      const ts = Math.floor(Date.now() / 1000);
      const signature = new Webhook(secret).sign(id, new Date(ts * 1000), payload);
      const headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signature };
      expect(failure(() => verify({ headers, payload, secrets: [secret] }))).toBe('ok');
    });
  });

  describe('v1a (Ed25519)', () => {
    const { secretKey, publicKey } = generateKeyPair();

    it('firma y verifica con la clave pública de confianza', () => {
      const headers = signedHeaders({ id, timestamp: NOW, payload, secretKeys: [secretKey] });
      expect(headers['webhook-signature']).toMatch(/^v1a,/);
      expect(failure(() => verify({ headers, payload, publicKeys: [publicKey], now: NOW }))).toBe('ok');
    });

    it('rechaza una clave pública que no está en la lista de confianza', () => {
      const headers = signedHeaders({ id, timestamp: NOW, payload, secretKeys: [secretKey] });
      const other = generateKeyPair().publicKey;
      expect(failure(() => verify({ headers, payload, publicKeys: [other], now: NOW }))).toBe('no_matching_signature');
    });

    it('acepta una semilla de 32 bytes además de la clave de 64', () => {
      const seedOnly = 'whsk_' + Buffer.from(secretKey.slice(5), 'base64').subarray(0, 32).toString('base64');
      const headers = signedHeaders({ id, timestamp: NOW, payload, secretKeys: [seedOnly] });
      expect(failure(() => verify({ headers, payload, publicKeys: [publicKey], now: NOW }))).toBe('ok');
    });
  });

  describe('rotación sin corte', () => {
    it('con dos firmas verifica con el secreto viejo o con el nuevo', () => {
      const oldSecret = generateSecret();
      const newSecret = generateSecret();
      const headers = signedHeaders({ id, timestamp: NOW, payload, secrets: [newSecret, oldSecret] });
      expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
      expect(failure(() => verify({ headers, payload, secrets: [oldSecret], now: NOW }))).toBe('ok');
      expect(failure(() => verify({ headers, payload, secrets: [newSecret], now: NOW }))).toBe('ok');
    });

    it('mezcla v1 y v1a en la misma cabecera', () => {
      const keys = generateKeyPair();
      const headers = signedHeaders({ id, timestamp: NOW, payload, secrets: [secret], secretKeys: [keys.secretKey] });
      expect(failure(() => verify({ headers, payload, publicKeys: [keys.publicKey], now: NOW }))).toBe('ok');
      expect(failure(() => verify({ headers, payload, secrets: [secret], now: NOW }))).toBe('ok');
    });
  });

  describe('lo que debe rechazar', () => {
    const headers = signedHeaders({ id, timestamp: NOW, payload, secrets: [secret] });

    it('un cuerpo alterado', () => {
      expect(failure(() => verify({ headers, payload: payload + ' ', secrets: [secret], now: NOW }))).toBe('no_matching_signature');
    });

    it('un id o un timestamp alterados', () => {
      expect(failure(() => verify({ headers: { ...headers, 'webhook-id': 'msg_otro' }, payload, secrets: [secret], now: NOW }))).toBe('no_matching_signature');
      expect(failure(() => verify({ headers: { ...headers, 'webhook-timestamp': String(NOW + 1) }, payload, secrets: [secret], now: NOW }))).toBe('no_matching_signature');
    });

    it('otro secreto', () => {
      expect(failure(() => verify({ headers, payload, secrets: [generateSecret()], now: NOW }))).toBe('no_matching_signature');
    });

    it('un timestamp fuera de la tolerancia, hacia atrás y hacia adelante, y acepta el borde', () => {
      expect(failure(() => verify({ headers, payload, secrets: [secret], now: NOW + 301 }))).toBe('timestamp_outside_tolerance');
      expect(failure(() => verify({ headers, payload, secrets: [secret], now: NOW - 301 }))).toBe('timestamp_outside_tolerance');
      expect(failure(() => verify({ headers, payload, secrets: [secret], now: NOW + 300 }))).toBe('ok');
    });

    it('cabeceras ausentes o timestamp que no es un entero', () => {
      expect(failure(() => verify({ headers: {}, payload, secrets: [secret], now: NOW }))).toBe('missing_headers');
      expect(failure(() => verify({ headers: { ...headers, 'webhook-timestamp': '12.5' }, payload, secrets: [secret], now: NOW }))).toBe('invalid_timestamp');
      expect(failure(() => verify({ headers: { ...headers, 'webhook-timestamp': 'abc' }, payload, secrets: [secret], now: NOW }))).toBe('invalid_timestamp');
    });

    it('una firma mal formada o vacía, sin explotar', () => {
      for (const bad of ['', 'v1', 'v1,', 'v2,AAAA', 'basura sin coma']) {
        expect(failure(() => verify({ headers: { ...headers, 'webhook-signature': bad || ' ' }, payload, secrets: [secret], now: NOW }))).not.toBe('ok');
      }
    });

    it('las cabeceras se leen sin distinguir mayúsculas', () => {
      const upper = { 'Webhook-Id': id, 'WEBHOOK-TIMESTAMP': String(NOW), 'Webhook-Signature': headers['webhook-signature'] };
      expect(failure(() => verify({ headers: upper, payload, secrets: [secret], now: NOW }))).toBe('ok');
    });
  });

  describe('secretos', () => {
    it('rechaza un secreto de menos de 24 o más de 64 bytes', () => {
      expect(() => generateSecret(23)).toThrow(RangeError);
      expect(() => generateSecret(65)).toThrow(RangeError);
      expect(() => sign({ id, timestamp: NOW, payload, secrets: ['whsec_' + Buffer.alloc(10).toString('base64')] })).toThrow(RangeError);
    });

    it('exige al menos un secreto o clave para firmar', () => {
      expect(() => sign({ id, timestamp: NOW, payload })).toThrow(RangeError);
    });
  });
});
