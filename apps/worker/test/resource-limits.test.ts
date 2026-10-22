import { afterAll, beforeEach, expect, test } from 'vitest'
import { RESOURCE_KEYS, settings, setResourceSettings, users } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { effectiveResourceLimits } from '../src/resource-limits'

const t = await setupTestDb()
const { db } = t
const env = { memoryBudgetMb: 5632, maxServiceMemoryMb: 2048 }

let adminId: string
afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  const [admin] = await db
    .insert(users)
    .values({ email: 'root@example.com', name: 'root', role: 'admin', passwordHash: 'x' })
    .returning({ id: users.id })
  adminId = admin!.id
})

test('the environment applies until an admin saves settings', async () => {
  expect(await effectiveResourceLimits(db, env)).toEqual(env)
})

test('saved settings win over the environment', async () => {
  await setResourceSettings(db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 4096 }, adminId)

  expect(await effectiveResourceLimits(db, env)).toEqual({ memoryBudgetMb: 8192, maxServiceMemoryMb: 4096 })
})

test('each value falls back to the environment on its own', async () => {
  await db.insert(settings).values({ key: RESOURCE_KEYS.memoryBudgetMb, value: 1024, updatedBy: adminId })
  expect(await effectiveResourceLimits(db, env)).toEqual({ memoryBudgetMb: 1024, maxServiceMemoryMb: 2048 })

  await db.delete(settings)
  await db.insert(settings).values({ key: RESOURCE_KEYS.maxServiceMemoryMb, value: 512, updatedBy: adminId })
  expect(await effectiveResourceLimits(db, env)).toEqual({ memoryBudgetMb: 5632, maxServiceMemoryMb: 512 })
})

test('a stored value that is not a positive whole number is ignored', async () => {
  await db.insert(settings).values({ key: RESOURCE_KEYS.memoryBudgetMb, value: 'lots', updatedBy: adminId })

  expect((await effectiveResourceLimits(db, env)).memoryBudgetMb).toBe(5632)
})

test('it is read fresh on every call', async () => {
  expect((await effectiveResourceLimits(db, env)).memoryBudgetMb).toBe(5632)
  await setResourceSettings(db, { memoryBudgetMb: 1024, maxServiceMemoryMb: 512 }, adminId)
  expect((await effectiveResourceLimits(db, env)).memoryBudgetMb).toBe(1024)
  await setResourceSettings(db, { memoryBudgetMb: 2048, maxServiceMemoryMb: 512 }, adminId)
  expect((await effectiveResourceLimits(db, env)).memoryBudgetMb).toBe(2048)
})
