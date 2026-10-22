import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { deployments, setDeploymentStatus } from '@vpsm/db'
import { ensureNetworkAttachments } from '../monitor/network-attachments'
import { reconcileLiveDeployments } from '../monitor/reconcile'
import type { PipelineDeps } from './pipeline'

const INTERRUPTED_REASON = 'worker restarted during deployment'

/**
 * Run once at startup, before the deploy loop: no deployment can be running yet, so anything the last
 * worker left mid-flight is cleaned up, in this order:
 * 1. claimed deployments (QUEUED with `claimed_at`, BUILDING, DEPLOYING) become FAILED;
 * 2. the work directory is emptied (a crash can leave a clone with the token in it);
 * 3. live deployments are reconciled: stopped containers are started again (e.g. after a host reboot),
 *    vanished ones CRASHED;
 * 4. Traefik and the worker are connected again to the networks of live deployments (a recreated
 *    container has lost them);
 * 5. the routes file is rewritten from the database, so no route points at an orphan any more;
 * 6. managed containers whose deployment is not SUCCESS or CRASHED (or no longer exists) are removed.
 */
export async function recoverInterruptedDeployments(
  deps: PipelineDeps,
): Promise<{ failed: number; removedContainers: number }> {
  const { db, docker } = deps

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

  await emptyWorkDir(deps.config.workDir)
  await reconcileLiveDeployments(deps, { startStopped: true })
  // Traefik may have been recreated since the last deployment, which detaches it from every app network.
  await ensureNetworkAttachments(deps)
  await deps.regenerateRoutes()

  const current = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, ['SUCCESS', 'CRASHED']))
  const keep = new Set(current.map((d) => d.id))
  const orphans = (await docker.listManaged()).filter((c) => !keep.has(c.deploymentId))
  for (const { name } of orphans) await docker.stopAndRemove(name, 0)

  return { failed: interrupted.length, removedContainers: orphans.length }
}

/** Removes everything in `workDir` (config guarantees it is a dedicated directory) but keeps the directory itself. */
async function emptyWorkDir(workDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(workDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // The directory itself may be a mounted volume.
  await Promise.all(entries.map((entry) => fs.rm(path.join(workDir, entry), { recursive: true, force: true })))
}
