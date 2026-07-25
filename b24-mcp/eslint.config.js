import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Guardrail: secrets must never reach stdout/stderr directly.
      'no-console': 'error',
    },
  },
  {
    files: ['src/security/logger.ts', 'src/audit/audit-log.ts'],
    rules: { 'no-console': 'off' },
  },
);
