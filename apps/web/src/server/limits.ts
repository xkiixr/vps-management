import { type Db, getResourceSettings } from '@vpsm/db'

/** The worker's default for MAX_SERVICE_MEMORY_MB (apps/worker/src/config.ts); keep the two the same. */
export const DEFAULT_MAX_SERVICE_MEMORY_MB = 2048

// A value the worker would accept: digits only, and more than zero. `FOO=` in an .env file means "not set".
function fromEnvironment(env: Record<string, string | undefined>): number {
  const value = env.MAX_SERVICE_MEMORY_MB
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_MAX_SERVICE_MEMORY_MB
  const megabytes = Number(value)
  return Number.isSafeInteger(megabytes) && megabytes > 0 ? megabytes : DEFAULT_MAX_SERVICE_MEMORY_MB
}

/**
 * The most memory one service may be given right now: what an admin saved in the dashboard, and if nothing was
 * saved, MAX_SERVICE_MEMORY_MB, else 2048. The worker makes the same choice (effectiveResourceLimits), so the
 * form accepts exactly what a deployment will later accept.
 */
export async function maxServiceMemoryMb(db: Db, env: Record<string, string | undefined> = process.env): Promise<number> {
  return (await getResourceSettings(db)).maxServiceMemoryMb ?? fromEnvironment(env)
}
