import { inArray } from 'drizzle-orm'
import { deployments, environments, serviceInstances } from '@vpsm/db'
import type { PipelineDeps } from '../deploy/pipeline'

export type SweepResult = { containers: number; networks: number; images: number }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** `networkName(environmentId)`; any other `vpsm-env-` name is left alone. */
const APP_NETWORK = new RegExp(`^vpsm-env-(${UUID})$`, 'i')
/** `imageTag(serviceInstanceId, deploymentId)` and other tags of that repository; anything else is left alone. */
const APP_IMAGE = new RegExp(`^vpsm/(${UUID}):.+$`, 'i')

const STOP_TIMEOUT_SEC = 10

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Removes managed containers whose deployment is not SUCCESS or CRASHED (or no longer exists, e.g. its service
 * was deleted). Only safe while no deployment is running: a running deployment's new container is not SUCCESS
 * yet. A container Docker will not remove is logged (as `<context>: ...`) and the others are still removed; it
 * is tried again the next time. Returns how many were removed.
 */
export async function removeOrphanedContainers(
  deps: Pick<PipelineDeps, 'db' | 'docker'>,
  opts: { timeoutSec: number; context: string },
): Promise<number> {
  const { db, docker } = deps
  const current = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, ['SUCCESS', 'CRASHED']))
  const keep = new Set(current.map((d) => d.id))
  const orphans = (await docker.listManaged()).filter((c) => !keep.has(c.deploymentId))
  let removed = 0
  for (const { name } of orphans) {
    try {
      await docker.stopAndRemove(name, opts.timeoutSec)
      removed++
    } catch (error) {
      console.error(`${opts.context}: could not remove orphaned container ${name}: ${messageOf(error)}`)
    }
  }
  return removed
}

/** App networks of environments that no longer exist (their project was deleted). */
async function removeOrphanedNetworks(deps: PipelineDeps): Promise<number> {
  const { db, docker } = deps
  const candidates = (await docker.listManagedNetworks()).flatMap((name) => {
    const id = APP_NETWORK.exec(name)?.[1]
    return id ? [{ name, id: id.toLowerCase() }] : []
  })
  if (candidates.length === 0) return 0
  const existing = await db
    .select({ id: environments.id })
    .from(environments)
    .where(inArray(environments.id, candidates.map((c) => c.id)))
  const keep = new Set(existing.map((e) => e.id))
  let removed = 0
  for (const { name } of candidates.filter((c) => !keep.has(c.id))) {
    try {
      await docker.removeNetwork(name)
      removed++
    } catch (error) {
      console.error(`orphan sweep: could not remove network ${name}: ${messageOf(error)}`)
    }
  }
  return removed
}

/** Images of service instances that no longer exist; image retention looks after those of existing ones. */
async function removeOrphanedImages(deps: PipelineDeps): Promise<number> {
  const { db, docker } = deps
  const candidates = (await docker.listManagedImages()).flatMap((tag) => {
    const id = APP_IMAGE.exec(tag)?.[1]
    return id ? [{ tag, instanceId: id.toLowerCase() }] : []
  })
  if (candidates.length === 0) return 0
  const existing = await db
    .select({ id: serviceInstances.id })
    .from(serviceInstances)
    .where(inArray(serviceInstances.id, [...new Set(candidates.map((c) => c.instanceId))]))
  const keep = new Set(existing.map((i) => i.id))
  let removed = 0
  for (const { tag } of candidates.filter((c) => !keep.has(c.instanceId))) {
    try {
      await docker.removeImage(tag)
      // removeImage leaves an image a container still uses; it is tried again the next time.
      if (!(await docker.imageExists(tag))) removed++
    } catch (error) {
      console.error(`orphan sweep: could not remove image ${tag}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Removes what a deleted service or project left behind in Docker, in this order: its containers (and any
 * other managed container whose deployment is not SUCCESS or CRASHED), the networks of environments that no
 * longer exist, the images of service instances that no longer exist. Then the routes file is rewritten from
 * the database, so no deleted service is routed any more. Must not run while a deployment is running (see
 * `removeOrphanedContainers`); the deploy loop runs it between deployments. A Docker error on one item is
 * logged and the others are still handled; so is a failure to rewrite the routes. Returns how many of each
 * were removed.
 */
export async function sweepOrphans(deps: PipelineDeps): Promise<SweepResult> {
  // Containers first: Docker does not remove an image a container still uses.
  const containers = await removeOrphanedContainers(deps, { timeoutSec: STOP_TIMEOUT_SEC, context: 'orphan sweep' })
  const networks = await removeOrphanedNetworks(deps)
  const images = await removeOrphanedImages(deps)
  try {
    await deps.regenerateRoutes()
  } catch (error) {
    console.error(`orphan sweep: could not rewrite the routes: ${messageOf(error)}`)
  }
  return { containers, networks, images }
}
