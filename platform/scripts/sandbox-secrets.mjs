#!/usr/bin/env node
// Genera los secretos SINTÉTICOS de la capa sandbox (D-26) para platform/compose.mock.yml: claves aleatorias que no sirven en ningún otro entorno.
//   node platform/scripts/sandbox-secrets.mjs [--force]
// Escribe platform/.sandbox/secrets.env (formato --env-file de Compose; modo 0600) y platform/.sandbox/operator-private.pem (la clave PRIVADA con la que
// `yarn seed:sandbox` firma la credencial de operador sintética; 0600). Ambos están en .gitignore. NO sobrescribe lo que ya existe salvo con --force
// (regenerarlos cambia las claves: hay que recrear los contenedores y vuelve inservible la siembra anterior).
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.sandbox');
const envFile = join(dir, 'secrets.env');
const keyFile = join(dir, 'operator-private.pem');
const force = process.argv.includes('--force');

if (!force && (existsSync(envFile) || existsSync(keyFile))) {
  process.stdout.write(`Ya existen los secretos de sandbox en ${dir}. Usá --force para regenerarlos (invalida la siembra y exige recrear los contenedores).\n`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
// En una línea, con \n literales (los servicios los convierten). Entre comillas simples: Compose no interpreta las barras.
const oneLine = publicPem.trim().replace(/\n/g, '\\n');

const lines = [
  '# SINTÉTICO, solo sandbox. Generado por platform/scripts/sandbox-secrets.mjs. No se versiona; no sirve en ningún otro entorno.',
  `SANDBOX_PAYER_HASH_KEY=sbx-${randomBytes(24).toString('hex')}`,
  `SANDBOX_WEBHOOKS_SECRET_KEK=${randomBytes(32).toString('base64')}`,
  `SANDBOX_CONNECTOR_MOCK_WEBHOOK_SECRET=whsec_${randomBytes(32).toString('base64')}`,
  `SANDBOX_OPERATOR_TOKEN_PUBLIC_KEY='${oneLine}'`,
  'SANDBOX_OPERATOR_TOKEN_ISSUER=pay-sandbox-identity',
  '',
];
writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
writeFileSync(keyFile, privatePem, { mode: 0o600 });
chmodSync(envFile, 0o600);
chmodSync(keyFile, 0o600);
process.stdout.write(`Secretos sintéticos de sandbox escritos en ${dir} (secrets.env y operator-private.pem, modo 0600).\n`);
