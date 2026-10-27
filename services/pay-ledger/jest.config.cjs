// Mismo esquema que mantra-core-health-api: MikroORM 7 es solo ESM, así que Jest corre en modo ESM
// (`node --experimental-vm-modules`) y SWC compila el TypeScript a ESM con los decoradores de NestJS (.swcrc).
const path = require('node:path');

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  setupFiles: ['<rootDir>/test/env.ts'],
  testRegex: '(src|test)/.*\\.spec\\.ts$',
  testTimeout: 20000,
  // Postgres de desarrollo compartido (max_connections=100) y varias suites de otros carriles corriendo a la vez: pocos workers (regla 70.3).
  maxWorkers: 2,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^@pay/([^/]+)$': path.join(__dirname, '../../contracts/packages/$1/src') },
  transform: { '^.+\\.(t|j)s$': '@swc/jest' },
  testEnvironment: 'node',
};
