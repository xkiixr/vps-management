import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createUser, setResourceSettings } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import {
  DEFAULT_MAX_SERVICE_MEMORY_MB,
  DEFAULT_MEMORY_BUDGET_MB,
  effectiveResourceSettings,
  maxServiceMemoryMb,
} from '@/server/limits'
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

describe('effectiveResourceSettings', () => {
  test('are the worker defaults (5632 and 2048 MB) with nothing saved and nothing in the environment', async () => {
    expect(DEFAULT_MEMORY_BUDGET_MB).toBe(5632)
    expect(await effectiveResourceSettings(t.db, {})).toEqual({
      memoryBudgetMb: { value: 5632, isDefault: true },
      maxServiceMemoryMb: { value: 2048, isDefault: true },
    })
  })

  test('the environment is the default for whatever has not been saved', async () => {
    expect(await effectiveResourceSettings(t.db, { MEMORY_BUDGET_MB: '8000', MAX_SERVICE_MEMORY_MB: '1024' })).toEqual({
      memoryBudgetMb: { value: 8000, isDefault: true },
      maxServiceMemoryMb: { value: 1024, isDefault: true },
    })
  })

  test('what an admin saved wins over the environment and is no longer the default', async () => {
    const admin = await createUser(t.db, { email: 'root@example.com', name: 'Root', role: 'admin', password: PASSWORD })
    await setResourceSettings(t.db, { memoryBudgetMb: 9000, maxServiceMemoryMb: 4096 }, admin.id)
    expect(await effectiveResourceSettings(t.db, { MEMORY_BUDGET_MB: '8000', MAX_SERVICE_MEMORY_MB: '1024' })).toEqual({
      memoryBudgetMb: { value: 9000, isDefault: false },
      maxServiceMemoryMb: { value: 4096, isDefault: false },
    })
  })

  test.each([[''], ['abc'], ['0'], ['-5'], ['1.5'], ['12MB'], [' ']])(
    'an environment value of %j is ignored, as the worker would refuse it',
    async (value) => {
      expect(await effectiveResourceSettings(t.db, { MEMORY_BUDGET_MB: value })).toMatchObject({
        memoryBudgetMb: { value: 5632, isDefault: true },
      })
    },
  )
})
