// Mismo esquema que mantra-core-health-api: MikroORM 7 es solo ESM, así que Jest corre en modo ESM
// (`node --experimental-vm-modules`) y SWC compila el TypeScript a ESM con los decoradores de NestJS (.swcrc).
const path = require('node:path');

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '(src|test)/.*\\.spec\\.ts$',
  testTimeout: 20000,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^@pay/([^/]+)$': path.join(__dirname, '../../contracts/packages/$1/src') },
  transform: { '^.+\\.(t|j)s$': '@swc/jest' },
  testEnvironment: 'node',
};
