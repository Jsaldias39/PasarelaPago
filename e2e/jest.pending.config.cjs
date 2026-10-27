// Pruebas e2e PENDIENTES: escritas contra el contrato, fuera de la suite por defecto hasta que los carriles que las bloquean terminen.
// `yarn e2e:pending` las corre; fallar acá NO es un defecto del arnés (ver docs/trabajo/ola-2/P1/ARNES.md, § Pendientes).
const base = require('./jest.config.cjs');

module.exports = { ...base, testMatch: ['<rootDir>/e2e/pending/**/*.e2e.ts'] };
