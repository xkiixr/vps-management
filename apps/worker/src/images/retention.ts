import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { DeploymentStatus } from '@vpsm/core'
import { type Db, deployments } from '@vpsm/db'
import type { WorkerConfig } from '../config'
import type { DockerRuntime } from '../runtime/docker-runtime'

/** A SUCCESS deployment's container runs from its image; a CRASHED one is still the service's current deployment. */
const PROTECTED_STATUSES: readonly DeploymentStatus[] = ['SUCCESS', 'CRASHED']

/**
 * Removes a service instance's old images. Keeps the newest `config.imageRetention` distinct tags (a
 * rollback reusing an old tag makes it recent again) and, whatever their age, the tags of SUCCESS and
 * CRASHED deployments. Returns the tags whose images it removed, oldest first.
 */
export async function cleanupImages(
  deps: { db: Db; docker: DockerRuntime; config: WorkerConfig },
  serviceInstanceId: string,
): Promise<string[]> {
  const { db, docker, config } = deps
  const rows = await db
    .select({ imageTag: deployments.imageTag, status: deployments.status })
    .from(deployments)
    .where(and(eq(deployments.serviceInstanceId, serviceInstanceId), isNotNull(deployments.imageTag)))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))

  const newestFirst = [...new Set(rows.map((r) => r.imageTag!))]
  const keep = new Set(newestFirst.slice(0, config.imageRetention))
  for (const { imageTag, status } of rows) if (PROTECTED_STATUSES.includes(status)) keep.add(imageTag!)

  const removed: string[] = []
  for (const tag of newestFirst.filter((t) => !keep.has(t)).reverse()) {
    // Older deployments' images are usually gone already (removed by an earlier cleanup).
    if (!(await docker.imageExists(tag))) continue
    await docker.removeImage(tag)
    // removeImage leaves an image that a container still uses; it is retried on the next cleanup.
    if (!(await docker.imageExists(tag))) removed.push(tag)
  }
  return removed
}
