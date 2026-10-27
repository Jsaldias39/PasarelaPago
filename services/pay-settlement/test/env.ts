import { generateKeyPairSync } from 'node:crypto';

// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_settlement';
process.env.DB_USER ??= 'pay_settlement';
process.env.DB_PASSWORD ??= 'dev_only_settlement';
process.env.NATS_URL ??= 'nats://127.0.0.1:54222';
// Los colaboradores se prueban con dobles o con un servidor HTTP local; estas URLs solo tienen que ser válidas para arrancar.
process.env.LEDGER_URL ??= 'http://127.0.0.1:9';
process.env.CONNECTORS_URL ??= 'http://127.0.0.1:9';
process.env.PAY_MODE ??= 'sandbox';
// Clave de operador de PRUEBA, generada en cada corrida: la privada vive en `globalThis` y nunca se escribe en disco.
if (!process.env.OPERATOR_TOKEN_PUBLIC_KEY) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.OPERATOR_TOKEN_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '\\n');
  (globalThis as { __OPERATOR_TEST_PRIVATE_KEY__?: string }).__OPERATOR_TEST_PRIVATE_KEY__ = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
process.env.OPERATOR_TOKEN_ISSUER ??= 'https://identidad.alovida.test';
process.env.OPERATOR_TOKEN_AUDIENCE ??= 'pay-settlement';
