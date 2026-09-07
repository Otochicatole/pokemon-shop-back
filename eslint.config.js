import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'storage/**', 'prisma/migrations/**'],
  },
  {
    files: ['**/*.js', '**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: {
      eqeqeq: 'error',
      curly: ['error', 'multi-line'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
];
