import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const integration = process.env.INTEGRATION === '1'

export default defineProject({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'web',
    include: integration ? ['test/**/*.int.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.int.test.ts'],
  },
})
