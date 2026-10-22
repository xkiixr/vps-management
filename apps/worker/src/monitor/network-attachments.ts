import { eq } from 'drizzle-orm'
import { networkName } from '@vpsm/core'
import { deployments, serviceInstances } from '@vpsm/db'
import type { PipelineDeps } from '../deploy/pipeline'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Connects Traefik and the worker to the network of every environment that has a live (SUCCESS)
 * deployment. A recreated Traefik or worker container loses its network attachments, and only a
 * deployment would put them back, so this repairs them without one. Connecting is idempotent. A failure
 * on one network is logged and does not stop the others. Returns how many networks were processed.
 */
export async function ensureNetworkAttachments(deps: PipelineDeps): Promise<number> {
  const { db, docker, config } = deps
  const rows = await db
    .selectDistinct({ environmentId: serviceInstances.environmentId })
    .from(deployments)
    .innerJoin(serviceInstances, eq(deployments.serviceInstanceId, serviceInstances.id))
    .where(eq(deployments.status, 'SUCCESS'))

  for (const { environmentId } of rows) {
    const net = networkName(environmentId)
    try {
      await docker.connect(config.traefikContainer, net)
      await docker.connect(config.workerContainer, net)
    } catch (error) {
      console.error(`network attachments: could not connect to ${net}: ${messageOf(error)}`)
    }
  }
  return rows.length
}
