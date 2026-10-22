import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { deployments, domains, type Db } from '@vpsm/db'
import { type Route, type RoutesTls, renderRoutesYaml, validateRoute, writeRoutesFile } from './traefik-config'

function deployPort(configSnapshot: unknown): number | undefined {
  const deploy = (configSnapshot as { deploy?: { port?: unknown } } | null)?.deploy
  const port = deploy?.port
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

const PANEL_RESERVED_REASON = 'hostname is reserved for the panel'

/** The router key of the panel; it cannot clash with a service instance id, which is a UUID. */
const PANEL_ROUTE_ID = 'panel'

export type OnInvalidRoute = (serviceInstanceId: string, reason: string) => void

const warnInvalidRoute: OnInvalidRoute = (serviceInstanceId, reason) => {
  console.warn(`skipping route for service instance ${serviceInstanceId}: ${reason}`)
}

// One route per service instance that has a live (SUCCESS) deployment and at least one domain.
// Normally an instance has a single SUCCESS deployment; if a stale one lingers, the newest wins.
// A route that cannot be rendered safely (no valid port, bad hostname, ...) is skipped and reported
// through `onInvalid`, so one bad row never takes routing down for every other service.
// An instance that has `panelDomain` among its hostnames is skipped as a whole: that name belongs to the panel.
export async function loadActiveRoutes(
  db: Db,
  onInvalid: OnInvalidRoute = warnInvalidRoute,
  panelDomain?: string,
): Promise<Route[]> {
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
    const { serviceInstanceId } = deployment
    const hostnames = hostnamesByInstance.get(serviceInstanceId)
    if (hostnames === undefined) continue
    if (panelDomain !== undefined && hostnames.some((hostname) => hostname.toLowerCase() === panelDomain.toLowerCase())) {
      onInvalid(serviceInstanceId, PANEL_RESERVED_REASON)
      continue
    }
    const port = deployPort(deployment.configSnapshot)
    if (port === undefined) {
      onInvalid(serviceInstanceId, `deployment ${deployment.id} has no valid deploy.port in its config snapshot`)
      continue
    }
    const route: Route = { serviceInstanceId, hostnames, upstreamUrl: `http://${deployment.containerName}:${port}` }
    try {
      validateRoute(route)
    } catch (error) {
      onInvalid(serviceInstanceId, error instanceof Error ? error.message : String(error))
      continue
    }
    routes.push(route)
  }
  return routes
}

/** With `panel`, the dashboard is routed too (even when no app is live) and no app can use its hostname. */
export async function regenerateRoutes(
  db: Db,
  dir: string,
  onInvalid?: OnInvalidRoute,
  tls?: RoutesTls,
  panel?: { domain: string; upstream: string },
): Promise<void> {
  const routes = await loadActiveRoutes(db, onInvalid, panel?.domain)
  if (panel) routes.unshift({ serviceInstanceId: PANEL_ROUTE_ID, hostnames: [panel.domain], upstreamUrl: panel.upstream })
  await writeRoutesFile(dir, renderRoutesYaml(routes, { tls }))
}
