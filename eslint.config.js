import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow empty functions (useful for default callbacks)
      '@typescript-eslint/no-empty-function': 'off',
      // Enforce explicit return types on functions
      '@typescript-eslint/explicit-function-return-type': 'off',
      // Allow non-null assertions in specific cases
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Prefer nullish coalescing
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      // Prefer optional chaining
      '@typescript-eslint/prefer-optional-chain': 'error',
      // Consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // No floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      // Require await in async functions
      '@typescript-eslint/require-await': 'warn',
      // No unnecessary conditions
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      'eslint.config.js',
    ],
  }
);
