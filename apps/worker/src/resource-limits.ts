import { type Db, getResourceSettings } from '@vpsm/db'
import type { WorkerConfig } from './config'

export type ResourceLimits = Pick<WorkerConfig, 'memoryBudgetMb' | 'maxServiceMemoryMb'>

/**
 * The memory limits in force right now: what an admin saved in the dashboard, and for whatever they have not
 * saved, the worker's environment. Read from the database on every call, so a change applies to the next
 * deployment without restarting the worker.
 */
export async function effectiveResourceLimits(db: Db, config: ResourceLimits): Promise<ResourceLimits> {
  const saved = await getResourceSettings(db)
  return {
    memoryBudgetMb: saved.memoryBudgetMb ?? config.memoryBudgetMb,
    maxServiceMemoryMb: saved.maxServiceMemoryMb ?? config.maxServiceMemoryMb,
  }
}
