import { defineProject } from 'vitest/config'

const integration = process.env.INTEGRATION === '1'

export default defineProject({
  test: {
    name: 'db',
    // Test files share one database and reset() truncates it, so run files one at a time.
    // (fileParallelism: false is ignored in a project config; a single fork is not.)
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: integration ? ['test/**/*.int.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.int.test.ts'],
  },
})
