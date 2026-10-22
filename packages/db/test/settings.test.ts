import { afterAll, beforeEach, expect, test } from 'vitest'
import {
  getResourceSettings,
  RESOURCE_KEYS,
  setResourceSettings,
  settings,
  users,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
const { db } = t
afterAll(() => t.close())

let adminId: string
beforeEach(async () => {
  await t.reset()
  const [admin] = await db
    .insert(users)
    .values({ email: 'root@example.com', name: 'root', role: 'admin', passwordHash: 'x' })
    .returning()
  adminId = admin!.id
})

test('the settings keys have the agreed names', () => {
  expect(RESOURCE_KEYS).toEqual({ memoryBudgetMb: 'memoryBudgetMb', maxServiceMemoryMb: 'maxServiceMemoryMb' })
})

test('nothing is set until an admin saves the settings', async () => {
  expect(await getResourceSettings(db)).toEqual({})
})

test('setResourceSettings stores both values with who changed them, and saving again replaces them', async () => {
  await setResourceSettings(db, { memoryBudgetMb: 4096, maxServiceMemoryMb: 1024 }, adminId)
  expect(await getResourceSettings(db)).toEqual({ memoryBudgetMb: 4096, maxServiceMemoryMb: 1024 })

  await setResourceSettings(db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 8192 }, adminId)
  expect(await getResourceSettings(db)).toEqual({ memoryBudgetMb: 8192, maxServiceMemoryMb: 8192 })

  const rows = await db.select().from(settings)
  expect(rows.map((r) => r.key).sort()).toEqual(['maxServiceMemoryMb', 'memoryBudgetMb'])
  for (const row of rows) expect(row.updatedBy).toBe(adminId)
})

test('settings: max cannot exceed budget', async () => {
  const error = await setResourceSettings(db, { memoryBudgetMb: 1024, maxServiceMemoryMb: 2048 }, adminId).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ValidationError)
  expect(await db.select().from(settings)).toHaveLength(0)
})

test.each([
  { memoryBudgetMb: 0, maxServiceMemoryMb: 0 },
  { memoryBudgetMb: -1024, maxServiceMemoryMb: 512 },
  { memoryBudgetMb: 1024.5, maxServiceMemoryMb: 512 },
  { memoryBudgetMb: 1024, maxServiceMemoryMb: Number.NaN },
  { memoryBudgetMb: 1024, maxServiceMemoryMb: 5 },
])('setResourceSettings refuses %o', async (v) => {
  await expect(setResourceSettings(db, v, adminId)).rejects.toBeInstanceOf(ValidationError)
  expect(await db.select().from(settings)).toHaveLength(0)
})

test('the smallest allowed max is 6 MB', async () => {
  await setResourceSettings(db, { memoryBudgetMb: 6, maxServiceMemoryMb: 6 }, adminId)
  expect(await getResourceSettings(db)).toEqual({ memoryBudgetMb: 6, maxServiceMemoryMb: 6 })
})

test.each<unknown>(['lots', -4096, 1.5, { mb: 4096 }])('getResourceSettings ignores a stored value of %o', async (bad) => {
  await db.insert(settings).values([
    { key: RESOURCE_KEYS.memoryBudgetMb, value: bad },
    { key: RESOURCE_KEYS.maxServiceMemoryMb, value: 512 },
    { key: 'unrelated', value: 1 },
  ])
  expect(await getResourceSettings(db)).toEqual({ maxServiceMemoryMb: 512 })
})
