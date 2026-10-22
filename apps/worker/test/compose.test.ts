import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { READY_FILE } from '../src/ready'

// The security rules of the control plane live in docker-compose.yml. This keeps a later edit from loosening one.

type Service = {
  build?: { context?: string; dockerfile?: string }
  container_name?: string
  ports?: unknown[]
  volumes?: string[]
  networks?: string[]
  env_file?: string | string[]
  environment?: Record<string, string>
  depends_on?: Record<string, { condition?: string }>
  healthcheck?: { test?: string[] }
  mem_limit?: string
  mem_reservation?: string
  oom_score_adj?: number
  restart?: string
  logging?: unknown
}

const read = (name: string): { services: Record<string, Service> } =>
  // `!override` in the dns-tls file is a Compose tag; it is read as the plain value it wraps.
  parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'), { logLevel: 'error' })

const compose = read('docker-compose.yml')
const override = read('docker-compose.dns-tls.yml')
const web = compose.services.web!
const worker = compose.services.worker!

describe('web', () => {
  test('is built from its Dockerfile at the repository root', () => {
    expect(web.build).toEqual({ context: '.', dockerfile: 'apps/web/Dockerfile' })
    expect(web.container_name).toBe('vpsm-web')
  })

  test('publishes no port: Traefik is the only way in', () => {
    expect(web.ports).toBeUndefined()
  })

  test('has no volumes at all, so no Docker socket', () => {
    expect(web.volumes).toBeUndefined()
  })

  test('only the worker mounts the Docker socket', () => {
    const holders = Object.entries(compose.services)
      .filter(([, service]) => (service.volumes ?? []).some((volume) => volume.includes('docker.sock')))
      .map(([name]) => name)
    expect(holders).toEqual(['worker'])
  })

  test('is on the control network (database) and the edge network (Traefik) and nowhere else', () => {
    expect([...(web.networks ?? [])].sort()).toEqual(['control', 'edge'])
  })

  // The dashboard faces the internet, so it gets exactly the settings it reads (apps/web/src/server/config.ts and
  // limits.ts) and not the whole .env: GITHUB_TOKEN, POSTGRES_PASSWORD, ACME_EMAIL, COMPOSE_FILE and whatever is added later stay out.
  test('gets an explicit list of settings and no env_file', () => {
    expect(web.env_file).toBeUndefined()
    expect(Object.keys(web.environment ?? {}).sort()).toEqual([
      'APPS_DOMAIN',
      'DATABASE_URL',
      'MAX_SERVICE_MEMORY_MB',
      'MEMORY_BUDGET_MB',
      'PANEL_DOMAIN',
      'PUBLIC_HTTPS_PORT',
    ])
    const text = JSON.stringify(web)
    for (const secret of ['GITHUB_TOKEN', 'POSTGRES_PASSWORD', 'ACME_EMAIL', 'COMPOSE_FILE', 'DUCKDNS_TOKEN']) {
      expect(text).not.toContain(secret)
    }
  })

  test('takes each setting from .env, requiring the ones it cannot work without', () => {
    expect(web.environment).toEqual({
      DATABASE_URL: expect.stringMatching(/^\$\{DATABASE_URL:\?[^}]+\}$/),
      APPS_DOMAIN: expect.stringMatching(/^\$\{APPS_DOMAIN:\?[^}]+\}$/),
      PANEL_DOMAIN: expect.stringMatching(/^\$\{PANEL_DOMAIN:\?[^}]+\}$/),
      PUBLIC_HTTPS_PORT: '${PUBLIC_HTTPS_PORT:-443}',
      MEMORY_BUDGET_MB: '${MEMORY_BUDGET_MB:-5632}',
      MAX_SERVICE_MEMORY_MB: '${MAX_SERVICE_MEMORY_MB:-2048}',
    })
  })

  test('is limited and protected like the other services, and restarts', () => {
    expect(web.mem_limit).toBe('512m')
    expect(web.mem_reservation).toBe('128m')
    expect(web.oom_score_adj).toBe(-900)
    expect(web.logging).toBe(worker.logging)
    expect(web.logging).toBeDefined()
    expect(web.restart).toBe('unless-stopped')
  })

  test('does not start before the database is healthy and the worker has migrated it', () => {
    expect(web.depends_on?.postgres?.condition).toBe('service_healthy')
    expect(web.depends_on?.worker?.condition).toBe('service_healthy')
  })
})

describe('worker', () => {
  test('is healthy exactly when it has written its ready file', () => {
    expect(worker.healthcheck?.test).toEqual(['CMD', 'test', '-f', READY_FILE])
  })

  test('still publishes no port', () => {
    expect(worker.ports).toBeUndefined()
  })
})

test('no service but Traefik publishes a port', () => {
  const publishing = Object.entries(compose.services)
    .filter(([, service]) => service.ports !== undefined)
    .map(([name]) => name)
  expect(publishing).toEqual(['traefik'])
})

test('Traefik has no forwardedHeaders setting: the login limiter trusts the X-Forwarded-For it sets', () => {
  for (const file of [compose, override]) {
    expect(JSON.stringify(file.services.traefik)).not.toMatch(/forwardedheaders|trustedips/i)
  }
})

test('the alternate-port override gives the web service the same public port as the worker, and nothing else', () => {
  expect(Object.keys(override.services.web?.environment ?? {})).toEqual(['PUBLIC_HTTPS_PORT'])
  expect(override.services.web?.env_file).toBeUndefined()
  expect(override.services.web?.environment?.PUBLIC_HTTPS_PORT).toBe('${TRAEFIK_HTTPS_PORT:-8443}')
  expect(override.services.web?.environment?.PUBLIC_HTTPS_PORT).toBe(override.services.worker?.environment?.PUBLIC_HTTPS_PORT)
  expect(override.services.web?.ports).toBeUndefined()
})
