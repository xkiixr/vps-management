import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createUser, setResourceSettings } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { DEFAULT_MAX_SERVICE_MEMORY_MB, maxServiceMemoryMb } from '@/server/limits'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

describe('maxServiceMemoryMb', () => {
  test('is 2048 MB (the worker default) with nothing saved and nothing in the environment', async () => {
    expect(DEFAULT_MAX_SERVICE_MEMORY_MB).toBe(2048)
    expect(await maxServiceMemoryMb(t.db, {})).toBe(2048)
  })

  test('the environment is the default for whatever has not been saved', async () => {
    expect(await maxServiceMemoryMb(t.db, { MAX_SERVICE_MEMORY_MB: '1024' })).toBe(1024)
  })

  test('what an admin saved wins over the environment', async () => {
    const admin = await createUser(t.db, { email: 'root@example.com', name: 'Root', role: 'admin', password: PASSWORD })
    await setResourceSettings(t.db, { memoryBudgetMb: 8000, maxServiceMemoryMb: 4096 }, admin.id)
    expect(await maxServiceMemoryMb(t.db, { MAX_SERVICE_MEMORY_MB: '1024' })).toBe(4096)
    expect(await maxServiceMemoryMb(t.db, {})).toBe(4096)
  })

  test.each([[''], ['abc'], ['0'], ['-5'], ['1.5'], ['12MB'], [' ']])(
    'an environment value of %j is ignored, as the worker would refuse it',
    async (value) => {
      expect(await maxServiceMemoryMb(t.db, { MAX_SERVICE_MEMORY_MB: value })).toBe(2048)
    },
  )
})
