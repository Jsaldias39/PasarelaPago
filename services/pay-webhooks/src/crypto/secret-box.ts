import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Sella y abre los secretos de firma con AES-256-GCM. Formato: `v1.<iv>.<tag>.<cifrado>` (base64url).
 * El `aad` ata el texto sellado a su contexto (el id del endpoint): un secreto copiado a otra fila no se abre.
 * La clave (`WEBHOOKS_SECRET_KEK`) viene del entorno y en producción de OpenBao; acá no se guarda ni se registra.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new RangeError('La clave de sellado debe tener 32 bytes');
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), encrypted].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
  }

  /** @throws Error si el texto fue alterado, es de otro contexto o se selló con otra clave. */
  open(sealed: string, aad: string): string {
    const [version, iv, tag, encrypted, ...rest] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || encrypted === undefined || rest.length > 0) throw new Error('Secreto sellado inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  }
}
