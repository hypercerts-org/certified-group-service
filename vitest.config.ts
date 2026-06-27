import { defineConfig, configDefaults } from 'vitest/config'
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--import', 'tsx/esm'],
      },
    },
    // tests/smoke/ holds manual smoke tests that hit a live deployment and need
    // real credentials; e2e/ holds the cucumber suite (run via `pnpm test:e2e`).
    // demo/ is a separate pnpm workspace with its own vitest run and deps (e.g.
    // @hypercerts-org/lexicon) that the root install doesn't have — its tests
    // must not be swept into the root suite. None belong in the automated suite.
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'e2e/**', 'demo/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Bootstrap entrypoint — wires the process together, no testable logic.
        'src/index.ts',
        // Type-only modules (interfaces / `import type`) — no runtime code to
        // cover; v8 reports them as 0% and skews the totals.
        'src/context.ts',
        'src/db/schema.ts',
      ],
      // Ratchet thresholds — only ever increase. See AGENTS.md.
      thresholds: {
        statements: 94,
        branches: 91,
        functions: 93,
        lines: 94,
      },
    },
  },
})
