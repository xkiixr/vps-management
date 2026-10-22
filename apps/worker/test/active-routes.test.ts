import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import {
  createAppService,
  createProject,
  deployments,
  domains,
  enqueueDeployment,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { loadActiveRoutes, regenerateRoutes } from '../src/routing/active-routes'

const t = await setupTestDb()
const { db } = t

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
})

async function addService(name: string): Promise<string> {
  const { instance } = await createAppService(db, {
    projectName: 'shop',
    serviceName: name,
    source: { repo: `acme/${name}`, branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  return instance.id
}

// Walks a fresh deployment through BUILDING and DEPLOYING the way the pipeline does.
async function deployUntilDeploying(serviceInstanceId: string, containerName: string, port: number): Promise<string> {
  const deployment = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await setDeploymentStatus(db, deployment.id, 'BUILDING')
  await setDeploymentStatus(db, deployment.id, 'DEPLOYING', { containerName, configSnapshot: { deploy: { port } } })
  return deployment.id
}

async function deployLive(serviceInstanceId: string, containerName: string, port: number, previousId?: string): Promise<string> {
  const id = await deployUntilDeploying(serviceInstanceId, containerName, port)
  await markDeploymentLive(db, { deploymentId: id, containerName, previousId })
  return id
}

test('only live deployments with domains are routed', async () => {
  const si1 = await addService('web')
  const si2 = await addService('api')
  const si3 = await addService('worker')

  await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)

  const failed = await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'manual' })
  await setDeploymentStatus(db, failed.id, 'BUILDING')
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'build failed' })

  await deployLive(si3, 'vpsm-worker-cccccccc', 9000)
  await db.delete(domains).where(eq(domains.serviceInstanceId, si3))

  expect(await loadActiveRoutes(db)).toEqual([
    { serviceInstanceId: si1, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-aaaaaaaa:3000' },
  ])
})

test('a deployment that is still deploying is not routed', async () => {
  const si1 = await addService('web')
  await deployUntilDeploying(si1, 'vpsm-web-aaaaaaaa', 3000)

  expect(await loadActiveRoutes(db)).toEqual([])
})

test('routes the new deployment once it replaces the previous one', async () => {
  const si1 = await addService('web')
  const first = await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)
  await deployLive(si1, 'vpsm-web-bbbbbbbb', 4000, first)

  expect(await loadActiveRoutes(db)).toEqual([
    { serviceInstanceId: si1, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-bbbbbbbb:4000' },
  ])
})

test('keeps routing the newest live deployment if an older one was never marked removed', async () => {
  const si1 = await addService('web')
  await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)
  await deployLive(si1, 'vpsm-web-bbbbbbbb', 4000)

  expect(await loadActiveRoutes(db)).toEqual([
    { serviceInstanceId: si1, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-bbbbbbbb:4000' },
  ])
})

test('a crashed deployment is not routed', async () => {
  const si1 = await addService('web')
  const id = await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)
  await setDeploymentStatus(db, id, 'CRASHED')

  expect(await loadActiveRoutes(db)).toEqual([])
})

test('collects every domain of an instance in sorted order', async () => {
  const si1 = await addService('web')
  await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)
  await db.insert(domains).values({ serviceInstanceId: si1, hostname: 'shop.example.org', kind: 'custom' })

  expect(await loadActiveRoutes(db)).toEqual([
    { serviceInstanceId: si1, hostnames: ['shop.example.org', 'web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-aaaaaaaa:3000' },
  ])
})

test('routes are ordered by service instance id', async () => {
  const ids = [await addService('web'), await addService('api'), await addService('docs')]
  for (const [i, id] of ids.entries()) await deployLive(id, `vpsm-svc-0000000${i}`, 8080)

  const routes = await loadActiveRoutes(db)

  expect(routes.map((r) => r.serviceInstanceId)).toEqual([...ids].sort())
})

// A live instance whose route cannot be rendered safely, next to a good sibling `web`.
async function goodAndBadWithHostname(): Promise<{ good: string; bad: string }> {
  const good = await addService('web')
  const bad = await addService('api')
  await deployLive(good, 'vpsm-web-aaaaaaaa', 3000)
  await deployLive(bad, 'vpsm-api-bbbbbbbb', 4000)
  await db.insert(domains).values({ serviceInstanceId: bad, hostname: 'Shop.Example.com', kind: 'custom' })
  return { good, bad }
}

async function goodAndBadWithoutPort(): Promise<{ good: string; bad: string; badDeploymentId: string }> {
  const good = await addService('web')
  const bad = await addService('api')
  await deployLive(good, 'vpsm-web-aaaaaaaa', 3000)
  const badDeploymentId = await deployLive(bad, 'vpsm-api-bbbbbbbb', 4000)
  await db.update(deployments).set({ configSnapshot: null }).where(eq(deployments.id, badDeploymentId))
  return { good, bad, badDeploymentId }
}

function collectInvalid(): { calls: [string, string][]; onInvalid: (id: string, reason: string) => void } {
  const calls: [string, string][] = []
  return { calls, onInvalid: (id, reason) => void calls.push([id, reason]) }
}

test('a route with an invalid hostname is skipped and reported, siblings are kept', async () => {
  const { good, bad } = await goodAndBadWithHostname()
  const { calls, onInvalid } = collectInvalid()

  expect(await loadActiveRoutes(db, onInvalid)).toEqual([
    { serviceInstanceId: good, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-aaaaaaaa:3000' },
  ])
  expect(calls).toEqual([[bad, 'invalid hostname: Shop.Example.com']])
})

test('a live deployment without a port in its snapshot is skipped and reported, siblings are kept', async () => {
  const { good, bad, badDeploymentId } = await goodAndBadWithoutPort()
  const { calls, onInvalid } = collectInvalid()

  expect(await loadActiveRoutes(db, onInvalid)).toEqual([
    { serviceInstanceId: good, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-aaaaaaaa:3000' },
  ])
  expect(calls).toEqual([[bad, `deployment ${badDeploymentId} has no valid deploy.port in its config snapshot`]])
})

test('invalid routes are warned about by default', async () => {
  const { bad } = await goodAndBadWithHostname()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await loadActiveRoutes(db)
    expect(warn).toHaveBeenCalledExactlyOnceWith(`skipping route for service instance ${bad}: invalid hostname: Shop.Example.com`)
  } finally {
    warn.mockRestore()
  }
})

test('regenerateRoutes writes the routes of live deployments to routes.yml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpsm-regen-'))
  try {
    const si1 = await addService('web')
    await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)

    await regenerateRoutes(db, dir)

    const yaml = await readFile(join(dir, 'routes.yml'), 'utf8')
    expect(yaml).toContain(`    r-${si1}:\n      rule: Host(\`web-shop.apps.example.com\`)\n`)
    expect(yaml).toContain('          - url: http://vpsm-web-aaaaaaaa:3000\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("regenerateRoutes passes the tls option on: 'entrypoint' renders routers without a tls section", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpsm-regen-'))
  try {
    const si1 = await addService('web')
    await deployLive(si1, 'vpsm-web-aaaaaaaa', 3000)

    await regenerateRoutes(db, dir, undefined, 'entrypoint')

    const yaml = await readFile(join(dir, 'routes.yml'), 'utf8')
    expect(yaml).toContain(`    r-${si1}:\n      rule: Host(\`web-shop.apps.example.com\`)\n`)
    expect(yaml).not.toContain('tls')
    expect(yaml).not.toContain('certResolver')

    await regenerateRoutes(db, dir, undefined, 'resolver')
    expect(await readFile(join(dir, 'routes.yml'), 'utf8')).toContain('        certResolver: le\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('regenerateRoutes still writes the good routes when a sibling is invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpsm-regen-'))
  try {
    const { good, bad } = await goodAndBadWithHostname()
    const { calls, onInvalid } = collectInvalid()

    await regenerateRoutes(db, dir, onInvalid)

    const yaml = await readFile(join(dir, 'routes.yml'), 'utf8')
    expect(yaml).toContain(`    r-${good}:\n`)
    expect(yaml).toContain('          - url: http://vpsm-web-aaaaaaaa:3000\n')
    expect(yaml).not.toContain(bad)
    expect(yaml).not.toContain('Shop.Example.com')
    expect(calls).toEqual([[bad, 'invalid hostname: Shop.Example.com']])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
