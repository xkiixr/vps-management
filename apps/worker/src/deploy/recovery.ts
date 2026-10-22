import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { deployments, setDeploymentStatus } from '@vpsm/db'
import type { PipelineDeps } from './pipeline'

const INTERRUPTED_REASON = 'worker restarted during deployment'

/**
 * Run once at startup, before the deploy loop: no deployment can be running yet, so anything the last
 * worker left mid-flight is cleaned up. Claimed deployments (QUEUED with `claimed_at`, BUILDING,
 * DEPLOYING) become FAILED; managed containers whose deployment is not SUCCESS or CRASHED (or no longer
 * exists) are removed; the work directory is emptied (a crash can leave a clone with the token in it);
 * the routes file is rewritten from the database. Live containers are never touched.
 */
export async function recoverInterruptedDeployments(
  deps: PipelineDeps,
): Promise<{ failed: number; removedContainers: number }> {
  const { db, docker } = deps
  await emptyWorkDir(deps.config.workDir)

  const interrupted = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      or(
        inArray(deployments.status, ['BUILDING', 'DEPLOYING']),
        and(eq(deployments.status, 'QUEUED'), isNotNull(deployments.claimedAt)),
      ),
    )
  for (const { id } of interrupted) {
    await setDeploymentStatus(db, id, 'FAILED', { failureReason: INTERRUPTED_REASON })
  }

  const current = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, ['SUCCESS', 'CRASHED']))
  const keep = new Set(current.map((d) => d.id))
  const orphans = (await docker.listManaged()).filter((c) => !keep.has(c.deploymentId))
  for (const { name } of orphans) await docker.stopAndRemove(name, 0)

  await deps.regenerateRoutes()
  return { failed: interrupted.length, removedContainers: orphans.length }
}

async function emptyWorkDir(workDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(workDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Keeps the directory itself: it may be a mounted volume.
  await Promise.all(entries.map((entry) => fs.rm(path.join(workDir, entry), { recursive: true, force: true })))
}
