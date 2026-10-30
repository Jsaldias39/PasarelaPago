import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Almacén de objetos de los documentos KYC. El archivo NO va a la base (regla 90.1.6): solo su clave, su hash y su tipo.
 * La implementación de producción (S3/MinIO con acceso autorizado y cifrado) todavía no existe: ver DECISIONES-TOMADAS D5-07.
 */
export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORE = Symbol('OBJECT_STORE');

const KEY = /^kyc\/mc_[a-z0-9]{10,40}\/kd_[a-z0-9]{10,40}$/;

/** [DEV] Filesystem local. Rechaza cualquier clave que no tenga la forma exacta (no hay recorrido de directorios). */
export class FsObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new RangeError('Clave de objeto inválida');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new RangeError('Clave de objeto fuera del almacén');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
