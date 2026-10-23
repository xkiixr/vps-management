import path from 'node:path'
import { z } from 'zod'
import { isValidHostname } from '@vpsm/core'
import { UPSTREAM_URL_PATTERN } from './routing/traefik-config'

export type WorkerConfig = {
  appsDomain: string
  traefikDynamicDir: string
  traefikContainer: string
  workerContainer: string
  frontendImage: string
  memoryBudgetMb: number
  maxServiceMemoryMb: number
  buildTimeoutMs: number
  drainSeconds: number
  imageRetention: number
  workDir: string
  /** `http01`: a certificate per host (Let's Encrypt HTTP-01 on port 80). `dns-wildcard`: one `*.APPS_DOMAIN` certificate (DNS-01). */
  tlsMode: 'http01' | 'dns-wildcard'
  /** The host port that reaches Traefik's HTTPS entrypoint; it only ends up in the URLs the worker prints. */
  publicHttpsPort: number
  /**
   * The GitHub App the team registered; without GITHUB_APP_ID there is none and only public repositories can be
   * cloned. The key is read from `privateKeyFile` by the worker alone and never leaves it.
   */
  githubApp?: { appId: number; privateKeyFile: string }
  /** The hostname of the web dashboard. Without it the worker does not route to the panel at all. */
  panelDomain?: string
  /** Where Traefik reaches the web dashboard: a container name on the shared network and its port. */
  panelUpstream: string
}

const text = (fallback: string) => z.string().default(fallback)
const absolutePath = (fallback: string) => text(fallback).refine((p) => path.isAbsolute(p), 'must be an absolute path')
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback)

/** The resolved path with a trailing separator, so `/a/b` is not taken for a parent of `/a/bc`. */
function asDir(p: string): string {
  const resolved = path.resolve(p)
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep
}
const depth = (p: string) => path.resolve(p).split(path.sep).filter(Boolean).length
const overlaps = (a: string, b: string) => asDir(a).startsWith(asDir(b)) || asDir(b).startsWith(asDir(a))

const fields = z.object({
  APPS_DOMAIN: z
    .string({ error: 'is required' })
    .refine(isValidHostname, 'must be a lowercase hostname such as apps.example.com'),
  TRAEFIK_DYNAMIC_DIR: absolutePath('/traefik/dynamic'),
  TRAEFIK_CONTAINER: text('vpsm-traefik'),
  WORKER_CONTAINER: text('vpsm-worker'),
  // Must stay the same version as the railpack CLI in the worker image.
  RAILPACK_FRONTEND_IMAGE: text('ghcr.io/railwayapp/railpack-frontend:v0.43.0'),
  MEMORY_BUDGET_MB: positiveInt(5632),
  MAX_SERVICE_MEMORY_MB: positiveInt(2048),
  BUILD_TIMEOUT_MINUTES: positiveInt(20),
  DRAIN_SECONDS: z.coerce.number().int().nonnegative().default(10),
  IMAGE_RETENTION: positiveInt(5),
  // Each deployment's checkout lives in `${WORK_DIR}/<id>` and is deleted recursively afterwards; the
  // worker also empties WORK_DIR at startup, so it must be a directory of its own.
  WORK_DIR: absolutePath('/var/lib/vpsm/work').refine(
    (p) => !path.isAbsolute(p) || depth(p) >= 2,
    'must be a dedicated directory at least two levels below / (such as /var/lib/vpsm/work)',
  ),
  TLS_MODE: z.enum(['http01', 'dns-wildcard']).default('http01'),
  PUBLIC_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  // A read-only bind mount (docker-compose.yml); the default is where the compose file puts it.
  GITHUB_APP_PRIVATE_KEY_FILE: absolutePath('/run/secrets/github-app.pem'),
  PANEL_DOMAIN: z.string().refine(isValidHostname, 'must be a lowercase hostname such as panel.apps.example.com').optional(),
  // Ends up in the Traefik config, so only `http://<container name>:<port>` is accepted.
  PANEL_UPSTREAM: text('http://vpsm-web:3000').refine((url) => UPSTREAM_URL_PATTERN.test(url), 'must look like http://vpsm-web:3000'),
})

const DUCKDNS_SUFFIX = '.duckdns.org'

const schema = fields.superRefine((e, ctx) => {
  if (path.isAbsolute(e.WORK_DIR) && path.isAbsolute(e.TRAEFIK_DYNAMIC_DIR) && overlaps(e.WORK_DIR, e.TRAEFIK_DYNAMIC_DIR)) {
    ctx.addIssue({ code: 'custom', path: ['WORK_DIR'], message: 'must not be, contain or be inside TRAEFIK_DYNAMIC_DIR' })
  }
  // docker-compose.dns-tls.yml sets both together; without it the apps are on the standard port with a certificate per host.
  if (e.TLS_MODE === 'http01' && e.PUBLIC_HTTPS_PORT !== 443) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_HTTPS_PORT'], message: 'must be 443 unless TLS_MODE is dns-wildcard' })
  }
  // The wildcard certificate is ordered with the DuckDNS DNS-01 challenge.
  if (e.TLS_MODE === 'dns-wildcard' && typeof e.APPS_DOMAIN === 'string' && !e.APPS_DOMAIN.endsWith(DUCKDNS_SUFFIX)) {
    ctx.addIssue({ code: 'custom', path: ['APPS_DOMAIN'], message: `must end with ${DUCKDNS_SUFFIX} when TLS_MODE is dns-wildcard` })
  }
  // The one certificate is for *.APPS_DOMAIN, and a wildcard covers a single label: panel.APPS_DOMAIN is served
  // with it, a.panel.APPS_DOMAIN or APPS_DOMAIN itself would get a certificate for another name.
  if (e.TLS_MODE === 'dns-wildcard' && typeof e.APPS_DOMAIN === 'string' && e.PANEL_DOMAIN !== undefined) {
    const suffix = `.${e.APPS_DOMAIN}`
    const label = e.PANEL_DOMAIN.slice(0, -suffix.length)
    if (!e.PANEL_DOMAIN.endsWith(suffix) || label === '' || label.includes('.')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PANEL_DOMAIN'],
        message: 'must be a single label under APPS_DOMAIN (such as panel.<APPS_DOMAIN>) when TLS_MODE is dns-wildcard',
      })
    }
  }
})

/** Reads the worker's settings from the environment. Throws one message naming every bad variable (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // `FOO=` in an .env file means "not set", not "set to nothing".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  const result = schema.safeParse(present)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
    throw new Error(`invalid worker configuration: ${problems.join('; ')}`)
  }
  const e = result.data
  return {
    appsDomain: e.APPS_DOMAIN,
    traefikDynamicDir: e.TRAEFIK_DYNAMIC_DIR,
    traefikContainer: e.TRAEFIK_CONTAINER,
    workerContainer: e.WORKER_CONTAINER,
    frontendImage: e.RAILPACK_FRONTEND_IMAGE,
    memoryBudgetMb: e.MEMORY_BUDGET_MB,
    maxServiceMemoryMb: e.MAX_SERVICE_MEMORY_MB,
    buildTimeoutMs: e.BUILD_TIMEOUT_MINUTES * 60_000,
    drainSeconds: e.DRAIN_SECONDS,
    imageRetention: e.IMAGE_RETENTION,
    workDir: e.WORK_DIR,
    tlsMode: e.TLS_MODE,
    publicHttpsPort: e.PUBLIC_HTTPS_PORT,
    ...(e.GITHUB_APP_ID === undefined
      ? {}
      : { githubApp: { appId: e.GITHUB_APP_ID, privateKeyFile: e.GITHUB_APP_PRIVATE_KEY_FILE } }),
    ...(e.PANEL_DOMAIN === undefined ? {} : { panelDomain: e.PANEL_DOMAIN }),
    panelUpstream: e.PANEL_UPSTREAM,
  }
}
