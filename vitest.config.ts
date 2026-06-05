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
    // real credentials — never run them as part of the automated suite.
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
  },
})
