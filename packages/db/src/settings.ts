import { inArray, sql } from 'drizzle-orm'
import { MIN_MEMORY_MB } from '@vpsm/core'
import type { Db } from './client'
import { ValidationError } from './errors'
import { settings } from './schema'

// Keys of the `settings` rows. A value missing from the table falls back to the worker's environment.
export const RESOURCE_KEYS = { memoryBudgetMb: 'memoryBudgetMb', maxServiceMemoryMb: 'maxServiceMemoryMb' } as const

type ResourceSettings = { memoryBudgetMb: number; maxServiceMemoryMb: number }

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

// A stored value that is not a positive whole number is ignored, as if it had never been set.
export async function getResourceSettings(db: Db): Promise<Partial<ResourceSettings>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(RESOURCE_KEYS)))
  const result: Partial<ResourceSettings> = {}
  for (const { key, value } of rows) {
    if (isPositiveInteger(value)) result[key as keyof ResourceSettings] = value
  }
  return result
}

// Both values are written in one transaction, so readers never see a max from one save and a budget from another.
export async function setResourceSettings(db: Db, v: ResourceSettings, actorId: string): Promise<void> {
  if (!isPositiveInteger(v.memoryBudgetMb)) throw new ValidationError('memory budget must be a positive whole number of MB')
  if (!isPositiveInteger(v.maxServiceMemoryMb) || v.maxServiceMemoryMb < MIN_MEMORY_MB) {
    throw new ValidationError(`max memory per service must be a positive whole number of at least ${MIN_MEMORY_MB} MB`)
  }
  if (v.maxServiceMemoryMb > v.memoryBudgetMb) {
    throw new ValidationError('max memory per service cannot be more than the memory budget')
  }

  await db.transaction(async (tx) => {
    for (const key of [RESOURCE_KEYS.memoryBudgetMb, RESOURCE_KEYS.maxServiceMemoryMb]) {
      const row = { key, value: v[key], updatedAt: sql`now()`, updatedBy: actorId }
      await tx.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row })
    }
  })
}
