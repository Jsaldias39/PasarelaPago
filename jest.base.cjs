// Configuración común de Jest para los paquetes y servicios (mismo transformador que mantra-core-health-api).
const path = require('node:path');

module.exports = {
  moduleNameMapper: { '^@pay/([^/]+)$': path.join(__dirname, 'contracts/packages/$1/src') },
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testTimeout: 15000,
  transform: { '^.+\\.(t|j)s$': ['@swc/jest', { jsc: { target: 'es2023', parser: { syntax: 'typescript', decorators: true } }, module: { type: 'commonjs' } }] },
  testEnvironment: 'node',
};
