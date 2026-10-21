import { defineProject } from 'vitest/config'

const integration = process.env.INTEGRATION === '1'

export default defineProject({
  test: {
    name: 'db',
    include: integration ? ['test/**/*.int.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.int.test.ts'],
  },
})
