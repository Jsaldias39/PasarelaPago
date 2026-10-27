#!/usr/bin/env node
// Emite una credencial de operador SINTÉTICA para SANDBOX (nunca para `live`): JWT RS256 con los roles pedidos, atado a `mode: sandbox`.
//
//   PAY_MODE=sandbox node scripts/sandbox-operator-token.mjs --roles merchant_operator,kyc_reviewer,legal_admin,pricing_admin \
//       --issuer pay-sandbox-identity --audience pay-merchants [--sub operador_sandbox_01] [--ttl-seconds 3600] [--private-key-file clave.pem]
//
// Sin --private-key-file genera un par RSA nuevo en memoria. Imprime un JSON con `OPERATOR_TOKEN_PUBLIC_KEY` / `_ISSUER` / `_AUDIENCE`
// (lo que configura el servicio al arrancar) y el `token` (lo que manda el operador en `Authorization: Bearer`). La clave privada NO se
// imprime ni se guarda salvo que se pida con --private-key-out. No hay ninguna clave, emisor ni audiencia por defecto.
import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.PAY_MODE !== 'sandbox') fail('Este script solo emite credenciales de SANDBOX: exige PAY_MODE=sandbox (jamás las de live).');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag?.startsWith('--') || process.argv[i + 1] === undefined) fail(`Argumento inválido: ${flag ?? ''}`);
  args.set(flag.slice(2), process.argv[i + 1]);
}
const need = (name) => args.get(name) || fail(`Falta --${name}`);
const roles = need('roles').split(',').map((r) => r.trim()).filter(Boolean);
if (roles.length === 0) fail('--roles no puede estar vacío');
const issuer = need('issuer');
const audience = need('audience');
const sub = args.get('sub') ?? 'operador_sandbox_01';
const ttl = Number(args.get('ttl-seconds') ?? 3600);
if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) fail('--ttl-seconds debe estar entre 1 y 86400');

let privateKey;
let publicKeyPem;
if (args.has('private-key-file')) {
  privateKey = createPrivateKey(readFileSync(args.get('private-key-file')));
  publicKeyPem = privateKey.export({ type: 'spki', format: 'pem' });
} else {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  if (args.has('private-key-out')) writeFileSync(args.get('private-key-out'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}

const now = Math.floor(Date.now() / 1000);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: issuer, aud: audience, sub, roles, mode: 'sandbox', iat: now, exp: now + ttl })}`;
const token = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;

process.stdout.write(
  `${JSON.stringify({ OPERATOR_TOKEN_PUBLIC_KEY: publicKeyPem.trim().replace(/\n/g, '\\n'), OPERATOR_TOKEN_ISSUER: issuer, OPERATOR_TOKEN_AUDIENCE: audience, token, roles, sub, expires_at: new Date((now + ttl) * 1000).toISOString() }, null, 2)}\n`,
);
