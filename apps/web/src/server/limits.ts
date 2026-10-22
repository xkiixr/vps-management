import { type Db, getResourceSettings } from '@vpsm/db'

/** The worker's default for MAX_SERVICE_MEMORY_MB (apps/worker/src/config.ts); keep the two the same. */
export const DEFAULT_MAX_SERVICE_MEMORY_MB = 2048
/** The worker's default for MEMORY_BUDGET_MB (apps/worker/src/config.ts); keep the two the same. */
export const DEFAULT_MEMORY_BUDGET_MB = 5632

type Env = Record<string, string | undefined>

// A value the worker would accept: digits only, and more than zero. `FOO=` in an .env file means "not set".
function fromEnvironment(env: Env, name: string, fallback: number): number {
  const value = env[name]
  if (value === undefined || !/^\d+$/.test(value)) return fallback
  const megabytes = Number(value)
  return Number.isSafeInteger(megabytes) && megabytes > 0 ? megabytes : fallback
}

/**
 * The most memory one service may be given right now: what an admin saved in the dashboard, and if nothing was
 * saved, MAX_SERVICE_MEMORY_MB, else 2048. The worker makes the same choice (effectiveResourceLimits), so the
 * form accepts exactly what a deployment will later accept.
 */
export async function maxServiceMemoryMb(db: Db, env: Env = process.env): Promise<number> {
  const saved = (await getResourceSettings(db)).maxServiceMemoryMb
  return saved ?? fromEnvironment(env, 'MAX_SERVICE_MEMORY_MB', DEFAULT_MAX_SERVICE_MEMORY_MB)
}

export type EffectiveSetting = {
  value: number
  /** True when nothing was saved and `value` comes from the environment (or the built-in default). */
  isDefault: boolean
}

/**
 * Both memory limits as the settings form shows them: what an admin saved, and for whatever was not saved the
 * environment's value (else the built-in default), which is what the worker uses (effectiveResourceLimits).
 */
export async function effectiveResourceSettings(
  db: Db,
  env: Env = process.env,
): Promise<{ memoryBudgetMb: EffectiveSetting; maxServiceMemoryMb: EffectiveSetting }> {
  const saved = await getResourceSettings(db)
  const resolve = (savedValue: number | undefined, name: string, fallback: number): EffectiveSetting =>
    savedValue === undefined
      ? { value: fromEnvironment(env, name, fallback), isDefault: true }
      : { value: savedValue, isDefault: false }
  return {
    memoryBudgetMb: resolve(saved.memoryBudgetMb, 'MEMORY_BUDGET_MB', DEFAULT_MEMORY_BUDGET_MB),
    maxServiceMemoryMb: resolve(saved.maxServiceMemoryMb, 'MAX_SERVICE_MEMORY_MB', DEFAULT_MAX_SERVICE_MEMORY_MB),
  }
}
