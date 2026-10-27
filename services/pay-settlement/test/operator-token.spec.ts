import { createSign, generateKeyPairSync } from 'node:crypto';
import { JwtOperatorVerifier } from '../src/settlement/operator-token';
import { AUDIENCE, ISSUER, operatorToken } from './helpers/app';

const pem = (process.env.OPERATOR_TOKEN_PUBLIC_KEY as string).replace(/\\n/g, '\n');
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const verifier = new JwtOperatorVerifier(pem, ISSUER, AUDIENCE, () => NOW);
const bearer = (token: string) => `Bearer ${token}`;
const token = (roles: string[], options: Parameters<typeof operatorToken>[1] = {}) => bearer(operatorToken(roles, { now: NOW, ...options }));
const b64 = (value: object | Buffer) => Buffer.from(value instanceof Buffer ? value : JSON.stringify(value)).toString('base64url');

describe('credencial de operador (JWT RS256)', () => {
  it('correcto: devuelve la identidad (sub) y los roles', async () => {
    expect(await verifier.verify(token(['settlement_operator'], { sub: 'op_maria01' }))).toEqual({ sub: 'op_maria01', roles: ['settlement_operator'] });
    expect(await verifier.verify(token(['settlement_operator', 'settlement_admin']))).toEqual({ sub: 'op_maria01', roles: ['settlement_operator', 'settlement_admin'] });
    expect(await verifier.verify(token([]))).toEqual({ sub: 'op_maria01', roles: [] });
    expect(await verifier.verify(token(['settlement_operator'], { claims: { aud: ['otro', AUDIENCE] } }))).not.toBeNull();
  });

  describe('límites de tiempo (tolerancia de reloj de 30 s)', () => {
    const exp = (secondsFromNow: number) => ({ claims: { exp: Math.floor(NOW / 1000) + secondsFromNow } });
    it.each([
      ['vence dentro de 1 s', 1, true],
      ['venció hace 29 s (dentro de la tolerancia)', -29, true],
      ['venció hace 30 s', -30, false],
      ['venció hace una hora', -3600, false],
    ])('exp: %s', async (_n, delta, ok) => {
      expect((await verifier.verify(token(['r'], exp(delta)))) !== null).toBe(ok);
    });
    it.each([
      ['nbf dentro de 29 s', 29, true],
      ['nbf dentro de 31 s', 31, false],
      ['nbf dentro de una hora', 3600, false],
    ])('nbf: %s', async (_n, delta, ok) => {
      expect((await verifier.verify(token(['r'], { claims: { nbf: Math.floor(NOW / 1000) + delta } }))) !== null).toBe(ok);
    });
    it('iat en el futuro se rechaza; exp ausente o no numérico también', async () => {
      expect(await verifier.verify(token(['r'], { claims: { iat: Math.floor(NOW / 1000) + 3600 } }))).toBeNull();
      expect(await verifier.verify(token(['r'], { claims: { exp: undefined } }))).toBeNull();
      expect(await verifier.verify(token(['r'], { claims: { exp: '9999999999' } }))).toBeNull();
    });
  });

  describe('lo que NUNCA se acepta', () => {
    it.each([
      ['sin cabecera', undefined],
      ['cabecera vacía', ''],
      ['sin el prefijo Bearer', operatorToken(['r'], { now: NOW })],
      ['esquema Basic', `Basic ${operatorToken(['r'], { now: NOW })}`],
      ['bearer en minúsculas', `bearer ${operatorToken(['r'], { now: NOW })}`],
      ['dos tokens', `Bearer ${operatorToken(['r'], { now: NOW })} ${operatorToken(['r'], { now: NOW })}`],
      ['solo dos segmentos', 'Bearer abc.def'],
      ['cuatro segmentos', 'Bearer a.b.c.d'],
      ['caracteres fuera de base64url', 'Bearer a$b.c d.e'],
      ['basura', 'Bearer ñandú'],
    ])('formato: %s', async (_n, header) => {
      expect(await verifier.verify(header as string | undefined)).toBeNull();
    });

    it('firma de otra clave, firma alterada y cuerpo alterado', async () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      expect(await verifier.verify(token(['settlement_admin'], { privateKey: other }))).toBeNull();
      const valid = operatorToken(['settlement_operator'], { now: NOW });
      const [h, p, s] = valid.split('.');
      expect(await verifier.verify(bearer(`${h}.${p}.${s.slice(0, -4)}AAAA`))).toBeNull();
      const escalated = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'op_maria01', roles: ['settlement_admin'], exp: Math.floor(NOW / 1000) + 300 });
      expect(await verifier.verify(bearer(`${h}.${escalated}.${s}`))).toBeNull(); // misma firma, roles cambiados
    });

    it('alg: none, HS256 con la clave pública como secreto (confusión de algoritmo) y cualquier alg distinto de RS256', async () => {
      const payload = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'op_x', roles: ['settlement_admin'], exp: Math.floor(NOW / 1000) + 300 });
      expect(await verifier.verify(bearer(`${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`))).toBeNull();
      expect(await verifier.verify(bearer(`${b64({ alg: 'none', typ: 'JWT' })}.${payload}.abc`))).toBeNull();
      const { createHmac } = await import('node:crypto');
      const hs = b64({ alg: 'HS256', typ: 'JWT' });
      const forged = createHmac('sha256', pem).update(`${hs}.${payload}`).digest('base64url');
      expect(await verifier.verify(bearer(`${hs}.${payload}.${forged}`))).toBeNull();
      for (const alg of ['RS384', 'RS512', 'PS256', 'ES256', 'EdDSA', 'rs256', '']) {
        const header = b64({ alg, typ: 'JWT' });
        const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign((globalThis as { __OPERATOR_TEST_PRIVATE_KEY__?: string }).__OPERATOR_TEST_PRIVATE_KEY__ as string).toString('base64url');
        expect(await verifier.verify(bearer(`${header}.${payload}.${signature}`))).toBeNull();
      }
    });

    it.each([
      ['emisor distinto', { iss: 'https://otro.test' }],
      ['audiencia distinta', { aud: 'otro-servicio' }],
      ['audiencia ausente', { aud: undefined }],
      ['audiencia como lista sin la nuestra', { aud: ['a', 'b'] }],
      ['sin sub', { sub: undefined }],
      ['sub vacío', { sub: '' }],
      ['sub numérico', { sub: 42 }],
      ['sub enorme', { sub: 'x'.repeat(101) }],
      ['sin roles', { roles: undefined }],
      ['roles como texto', { roles: 'settlement_admin' }],
      ['roles con algo que no es texto', { roles: ['settlement_operator', 7] }],
    ])('claims: %s', async (_n, claims) => {
      expect(await verifier.verify(token(['settlement_operator'], { claims }))).toBeNull();
    });

    it('cabecera ilegible o cuerpo que no es JSON no lanzan: devuelven null', async () => {
      const key = (globalThis as { __OPERATOR_TEST_PRIVATE_KEY__?: string }).__OPERATOR_TEST_PRIVATE_KEY__ as string;
      const sign = (h: string, p: string) => createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
      const h = b64({ alg: 'RS256' });
      const junk = Buffer.from('no es json').toString('base64url');
      expect(await verifier.verify(bearer(`${junk}.${junk}.${sign(junk, junk)}`))).toBeNull();
      expect(await verifier.verify(bearer(`${h}.${junk}.${sign(h, junk)}`))).toBeNull();
    });
  });

  it('una clave pública inválida falla al construir (el servicio no arranca con una verificación rota)', () => {
    expect(() => new JwtOperatorVerifier('no es un PEM', ISSUER, AUDIENCE)).toThrow();
  });
});
