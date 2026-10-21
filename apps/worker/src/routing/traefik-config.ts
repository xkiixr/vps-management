import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidHostname } from '@vpsm/core'
import { stringify } from 'yaml'

export type Route = { serviceInstanceId: string; hostnames: string[]; upstreamUrl: string }

const ROUTES_FILE = 'routes.yml'
const ENTRY_POINT = 'websecure'
const CERT_RESOLVER = 'le'

// These values come from the database but end up inside Traefik config (keys, rules, urls),
// so anything that could alter the structure of that config is refused.
const SERVICE_INSTANCE_ID_PATTERN = /^[a-z0-9-]+$/
const UPSTREAM_URL_PATTERN = /^http:\/\/[a-z0-9-]+:[0-9]+$/

function validateRoute(route: Route): void {
  if (!SERVICE_INSTANCE_ID_PATTERN.test(route.serviceInstanceId)) {
    throw new Error(`invalid route: service instance id ${JSON.stringify(route.serviceInstanceId)}`)
  }
  if (!UPSTREAM_URL_PATTERN.test(route.upstreamUrl)) {
    throw new Error(`invalid route: upstream url ${JSON.stringify(route.upstreamUrl)}`)
  }
  if (route.hostnames.length === 0) {
    throw new Error(`invalid route: no hostnames for service instance ${route.serviceInstanceId}`)
  }
  for (const hostname of route.hostnames) {
    if (!isValidHostname(hostname)) throw new Error(`invalid hostname: ${hostname}`)
  }
}

export function renderRoutesYaml(routes: Route[]): string {
  const routers: Record<string, unknown> = {}
  const services: Record<string, unknown> = {}
  for (const route of routes) {
    validateRoute(route)
    const rule = [...route.hostnames]
      .sort()
      .map((hostname) => `Host(\`${hostname}\`)`)
      .join(' || ')
    routers[`r-${route.serviceInstanceId}`] = {
      rule,
      entryPoints: [ENTRY_POINT],
      service: `s-${route.serviceInstanceId}`,
      tls: { certResolver: CERT_RESOLVER },
    }
    services[`s-${route.serviceInstanceId}`] = { loadBalancer: { servers: [{ url: route.upstreamUrl }] } }
  }
  // lineWidth 0: never fold long rules (many hostnames) across lines.
  return stringify({ http: { routers, services } }, { lineWidth: 0 })
}

// Traefik watches the directory, so the file must never be visible half-written:
// write a sibling temp file and rename it over routes.yml (atomic on the same filesystem).
export async function writeRoutesFile(dir: string, yaml: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmpPath = join(dir, `${ROUTES_FILE}.tmp`)
  await writeFile(tmpPath, yaml)
  await rename(tmpPath, join(dir, ROUTES_FILE))
}
