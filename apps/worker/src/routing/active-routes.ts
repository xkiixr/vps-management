import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { deployments, domains, type Db } from '@vpsm/db'
import { type Route, renderRoutesYaml, writeRoutesFile } from './traefik-config'

function deployPort(configSnapshot: unknown): number | undefined {
  const deploy = (configSnapshot as { deploy?: { port?: unknown } } | null)?.deploy
  const port = deploy?.port
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

// One route per service instance that has a live (SUCCESS) deployment and at least one domain.
// Normally an instance has a single SUCCESS deployment; if a stale one lingers, the newest wins.
export async function loadActiveRoutes(db: Db): Promise<Route[]> {
  const live = await db
    .selectDistinctOn([deployments.serviceInstanceId], {
      id: deployments.id,
      serviceInstanceId: deployments.serviceInstanceId,
      containerName: deployments.containerName,
      configSnapshot: deployments.configSnapshot,
    })
    .from(deployments)
    .where(and(eq(deployments.status, 'SUCCESS'), isNotNull(deployments.containerName)))
    .orderBy(asc(deployments.serviceInstanceId), desc(deployments.createdAt), desc(deployments.id))
  if (live.length === 0) return []

  const rows = await db
    .select({ serviceInstanceId: domains.serviceInstanceId, hostname: domains.hostname })
    .from(domains)
    .where(
      inArray(
        domains.serviceInstanceId,
        live.map((d) => d.serviceInstanceId),
      ),
    )
    .orderBy(asc(domains.hostname))
  const hostnamesByInstance = new Map<string, string[]>()
  for (const { serviceInstanceId, hostname } of rows) {
    hostnamesByInstance.set(serviceInstanceId, [...(hostnamesByInstance.get(serviceInstanceId) ?? []), hostname])
  }

  const routes: Route[] = []
  for (const deployment of live) {
    const hostnames = hostnamesByInstance.get(deployment.serviceInstanceId)
    if (hostnames === undefined) continue
    const port = deployPort(deployment.configSnapshot)
    if (port === undefined) throw new Error(`deployment ${deployment.id} has no valid deploy.port in its config snapshot`)
    routes.push({
      serviceInstanceId: deployment.serviceInstanceId,
      hostnames,
      upstreamUrl: `http://${deployment.containerName}:${port}`,
    })
  }
  return routes
}

export async function regenerateRoutes(db: Db, dir: string): Promise<void> {
  await writeRoutesFile(dir, renderRoutesYaml(await loadActiveRoutes(db)))
}
