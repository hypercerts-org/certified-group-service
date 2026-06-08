import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/',
      'node_modules/',
      'tmp/',
      'coverage/',
      'data/',
      // demo/ is a standalone Vite + BFF subproject with its own
      // package.json and tsconfig; it is not linted by the root config.
      'demo/',
      // Claude Code creates sibling worktrees here, each a full checkout
      // with its own node_modules and tsconfig. Without this ignore,
      // eslint's projectService discovers every tsconfig in every worktree
      // and OOMs on `eslint .`.
      '.claude/worktrees/',
      'vitest.config.ts',
      'eslint.config.js',
      // Cucumber config (plain ESM, not covered by the TS project)
      'e2e/cucumber.mjs',
      // Standalone Node scripts not covered by any tsconfig
      'scripts/**',
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript recommended rules (type-checked)
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with _ (intentional omission)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // `const { omitted, ...rest } = obj` to strip a key is idiomatic
          ignoreRestSiblings: true,
        },
      ],

      // Empty catch blocks are an intentional "best-effort cleanup" pattern
      // in teardown hooks (e.g. afterEach destroy()).
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Express handler patterns pass void-returning async callbacks
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],

      // The atproto SDK (AtpAgent, lexicon, xrpc) and kysely surface values
      // typed as `any` at the boundary. Linting the propagation of those
      // values is noise — keep `no-explicit-any` on so we don't *introduce*
      // new `any`, but allow the values that cross the SDK boundary to flow.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Tests build mock verifiers, fake PDS handlers, and partial fixtures
  // where explicit `any` and non-awaiting async stubs are expected.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Disable formatting rules that conflict with Prettier
  prettier,
)
