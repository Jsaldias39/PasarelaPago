import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.yarn/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Sin console.* en el código que se despliega: un volcado de cabeceras o cuerpos puede filtrar firmas, claves o datos
    // personales (regla 90.2.1). Los servicios loguean con el logger estructurado, que redacta credenciales.
    files: ['services/**/src/**/*.ts', 'contracts/packages/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/testing/**'],
    rules: { 'no-console': 'error' },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
