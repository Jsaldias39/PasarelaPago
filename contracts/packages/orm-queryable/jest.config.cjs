const path = require('node:path');

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^@pay/([^/]+)$': path.join(__dirname, '../$1/src') },
  transform: { '^.+\\.(t|j)s$': '@swc/jest' },
  testEnvironment: 'node',
};
