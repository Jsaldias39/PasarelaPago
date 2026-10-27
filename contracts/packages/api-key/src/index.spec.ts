import { generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from './index';

describe('api-key (D-27)', () => {
  it('genera una clave con el formato del contrato y la reconoce', () => {
    const key = generateApiKey('live');
    expect(key.keyId).toMatch(/^key_[a-z0-9]{10,40}$/);
    expect(key.token).toMatch(/^sk_live_[a-z2-7]{16}_[a-z2-7]{32}$/);
    expect(key.keyHash).toMatch(/^sha256\$[0-9a-f]{64}$/);
    expect(key.last4).toHaveLength(4);
    expect(key.token.endsWith(key.last4)).toBe(true);
    expect(parseApiKey(key.token)).toEqual({ mode: 'live', keyId: key.keyId, secret: key.token.slice(-32) });
  });

  it('el token cumple el patrón de secret del contrato público (`^sk_(test|live)_`)', () => {
    expect(generateApiKey('test').token).toMatch(/^sk_(test|live)_/);
  });

  it('verifica la clave correcta y rechaza cualquier alteración', () => {
    const key = generateApiKey('test');
    expect(verifyApiKey(key.token, key)).toBe(true);
    const tampered = key.token.slice(0, -1) + (key.token.endsWith('a') ? 'b' : 'a');
    expect(verifyApiKey(tampered, key)).toBe(false);
    const other = generateApiKey('test');
    expect(verifyApiKey(other.token, key)).toBe(false);
    // el token de otra clave con el keyId cambiado a mano tampoco pasa
    const spliced = `sk_test_${key.keyId.slice(4)}_${other.token.slice(-32)}`;
    expect(verifyApiKey(spliced, key)).toBe(false);
  });

  describe('confusión de modo (hallazgo de la revisión de seguridad)', () => {
    it('una clave TEST reescrita como LIVE NO verifica contra su registro, ni contra uno cuyo modo se tomó del token', () => {
      const test = generateApiKey('test');
      const forged = test.token.replace('sk_test_', 'sk_live_');
      expect(verifyApiKey(forged, test)).toBe(false); // el registro dice `test`
      // aunque quien llama construya el registro con el modo del token (el error que se quiere impedir), el hash ya no coincide
      expect(verifyApiKey(forged, { keyId: test.keyId, mode: 'live', keyHash: test.keyHash })).toBe(false);
    });

    it('una clave LIVE reescrita como TEST tampoco verifica', () => {
      const live = generateApiKey('live');
      const forged = live.token.replace('sk_live_', 'sk_test_');
      expect(verifyApiKey(forged, live)).toBe(false);
      expect(verifyApiKey(forged, { keyId: live.keyId, mode: 'test', keyHash: live.keyHash })).toBe(false);
    });

    it('el mismo secreto con otro modo o con otro id produce otro hash', () => {
      const base = { mode: 'test' as const, keyId: 'key_aaaaaaaaaaaaaaaa', secret: 'b'.repeat(32) };
      const hashes = new Set([hashApiKey(base), hashApiKey({ ...base, mode: 'live' }), hashApiKey({ ...base, keyId: 'key_cccccccccccccccc' })]);
      expect(hashes.size).toBe(3);
    });

    it('un registro cuyo modo no coincide con el del token se rechaza aunque el hash sea el correcto', () => {
      const key = generateApiKey('live');
      expect(verifyApiKey(key.token, { keyId: key.keyId, mode: 'test', keyHash: key.keyHash })).toBe(false);
    });
  });

  it('un token test y uno live con el mismo secreto son claves distintas', () => {
    const live = generateApiKey('live');
    const asTest = live.token.replace('sk_live_', 'sk_test_');
    expect(parseApiKey(asTest)?.mode).toBe('test');
    expect(parseApiKey(asTest)?.keyId).toBe(live.keyId);
    expect(verifyApiKey(asTest, live)).toBe(false);
  });

  it('verifyApiKey no lanza ante un hash guardado mal formado', () => {
    const key = generateApiKey('test');
    for (const keyHash of ['', '$argon2id$v=19$...', `sha256$${'z'.repeat(64)}`]) {
      expect(verifyApiKey(key.token, { keyId: key.keyId, mode: 'test', keyHash })).toBe(false);
    }
  });

  it.each([undefined, null, 42, '', 'sk_live_', 'sk_prod_aaaaaaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'SK_LIVE_AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'sk_live_aaaaaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sk_live_aaaaaaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', `sk_live_aaaaaaaaaaaaaaaa_${'a'.repeat(500)}`, 'sk_live_aaaaaaaaaaaaaaa1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])(
    'parseApiKey devuelve null para %p sin lanzar',
    (value) => expect(parseApiKey(value)).toBeNull(),
  );

  it('1.000 claves no colisionan (ids ni secretos)', () => {
    const ids = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const key = generateApiKey('test');
      ids.add(key.keyId);
      secrets.add(key.token.slice(-32));
    }
    expect(ids.size).toBe(1000);
    expect(secrets.size).toBe(1000);
  });

  it('la distribución de los caracteres es uniforme (sin sesgo del módulo)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) for (const c of generateApiKey('test').token.slice(-32)) counts.set(c, (counts.get(c) ?? 0) + 1);
    const values = [...counts.values()];
    expect(counts.size).toBe(32);
    // esperado 2000*32/32 = 2000 por carácter; ±15 % sobra para el azar y detecta un sesgo grosero
    for (const v of values) expect(v).toBeGreaterThan(1700);
    for (const v of values) expect(v).toBeLessThan(2300);
  });
});
