// Pruebas e2e: UN solo proceso de Jest (un solo stack a la vez) y tiempos largos (arrancan 11 servicios reales).
const path = require('node:path');

module.exports = {
  rootDir: path.join(__dirname, '..'),
  testMatch: ['<rootDir>/e2e/flows/**/*.e2e.ts', '<rootDir>/e2e/lib/**/*.spec.ts'],
  testEnvironment: 'node',
  maxWorkers: 1,
  testTimeout: 180000,
  moduleNameMapper: { '^@pay/([^/]+)$': '<rootDir>/contracts/packages/$1/src' },
  transform: { '^.+\\.ts$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }] },
};
