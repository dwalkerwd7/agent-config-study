// Static analysis on top of `tsc`. Type-aware, so it catches what the compiler
// cannot: floating promises, unsafe `any` flow, misused async callbacks.
// Formatting belongs to prettier, not here.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'study/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Every file belongs to a real tsconfig: each package's own, and a
        // tests/tsconfig.json beside its tests. The default project is capped
        // at 8 files, so leaning on it for tests broke once they outgrew it.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      // Callbacks passed where an async function is expected are async by
      // contract; an await-free one is correct, not a smell.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Build and tool config: outside every tsconfig, so lint it untyped.
    files: ['**/*.js', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
