import { randomBytes } from 'node:crypto';
import { SecretBox } from '../src/crypto/secret-box';

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(randomBytes(32));

  it('CORRECTO: sella y abre con el mismo contexto; cada sellado es distinto (IV aleatorio)', () => {
    const a = box.seal('whsec_abc', 'we_1');
    const b = box.seal('whsec_abc', 'we_1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('whsec_abc');
    expect(box.open(a, 'we_1')).toBe('whsec_abc');
  });

  it('INVÁLIDO: otro contexto (el secreto copiado a otro endpoint) no se abre', () => {
    expect(() => box.open(box.seal('whsec_abc', 'we_1'), 'we_2')).toThrow();
  });

  it('INVÁLIDO: otra clave no abre', () => {
    expect(() => new SecretBox(randomBytes(32)).open(box.seal('x', 'we_1'), 'we_1')).toThrow();
  });

  it('INVÁLIDO: texto alterado (un byte) o con formato roto', () => {
    const sealed = box.seal('whsec_abc', 'we_1');
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 3), Buffer.from(Buffer.from(parts[3], 'base64url').map((byte, i) => (i === 0 ? byte ^ 1 : byte))).toString('base64url')].join('.');
    expect(() => box.open(flipped, 'we_1')).toThrow();
    for (const broken of ['', 'v1', 'v2.a.b.c', 'v1.a.b', 'v1.a.b.c.d']) expect(() => box.open(broken, 'we_1')).toThrow();
  });

  it('LÍMITE: una clave que no mide 32 bytes se rechaza al construir', () => {
    for (const size of [0, 16, 31, 33, 64]) expect(() => new SecretBox(randomBytes(size))).toThrow(RangeError);
  });

  it('LÍMITE: texto vacío y unicode', () => {
    expect(box.open(box.seal('', 'we_1'), 'we_1')).toBe('');
    expect(box.open(box.seal('ñandú ✓', 'we_1'), 'we_1')).toBe('ñandú ✓');
  });
});
