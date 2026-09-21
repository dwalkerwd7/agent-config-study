// Static analysis on top of `tsc`. Type-aware, so it catches what the compiler
// cannot: floating promises, unsafe `any` flow, misused async callbacks.
// Formatting belongs to prettier, not here.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'packages/db/src/generated/**',
      'apps/web/next-env.d.ts',
      'study/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          // Tests sit outside every package's `include`.
          allowDefaultProject: ['packages/*/tests/*.ts', 'apps/*/tests/*.ts'],
        },
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
      // Fastify plugins, route handlers and BullMQ processors are async by
      // contract; an await-free one is correct, not a smell.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Build and tool config: outside every tsconfig, so lint it untyped.
    files: ['**/*.js', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
    settings: { next: { rootDir: 'apps/web' } },
  },
);
