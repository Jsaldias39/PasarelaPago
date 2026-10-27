import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCertificate {
  readonly cert: string;
  readonly key: string;
  dispose(): void;
}

/** Certificado autofirmado SOLO para pruebas, válido para `hostname` (SAN). Se borra con `dispose()`. */
export function createTestCertificate(hostname: string): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'pay-webhooks-tls-'));
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`, '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  const key = readFileSync(join(dir, 'k.pem'), 'utf8');
  return { cert, key, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
