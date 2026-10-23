import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_DEPLOY_CONFIG, type DeployConfig, type DeploymentTrigger } from '@vpsm/core'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  type Deployment,
  deploymentLogs,
  deployments,
  domains,
  enqueueDeployment,
  markDeploymentLive,
  serviceInstances,
  setDeploymentStatus,
  setResourceSettings,
  users,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { BuildError } from '../src/build/errors'
import { runDeployment } from '../src/deploy/pipeline'
import { waitHealthy } from '../src/runtime/healthcheck'
import { SourceError } from '../src/source/fetch-source'
import { fakeDeps, type FakeDeps } from './fakes'

// Every status a deployment was asked to move to, starting from QUEUED. Recorded before the real call,
// so an invalid transition the pipeline attempts shows up here too.
const history = vi.hoisted(() => new Map<string, string[]>())
// Set to make the next loadDeploymentContext call throw this error.
const loadFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
// What the database held at the moment the worker closed the log of a deployment, and a failure to inject there.
const closing = vi.hoisted(() => ({
  observe: undefined as ((id: string) => Promise<ClosingSnapshot>) | undefined,
  snapshots: new Map<string, ClosingSnapshot>(),
  error: undefined as Error | undefined,
}))
type ClosingSnapshot = { status: string; closedAt: Date | null; lines: string[] }

vi.mock('@vpsm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vpsm/db')>()
  const record = (id: string, status: string) => history.set(id, [...(history.get(id) ?? ['QUEUED']), status])
  return {
    ...actual,
    setDeploymentStatus: async (...args: Parameters<typeof actual.setDeploymentStatus>) => {
      record(args[1], args[2])
      return actual.setDeploymentStatus(...args)
    },
    markDeploymentLive: async (...args: Parameters<typeof actual.markDeploymentLive>) => {
      record(args[1].deploymentId, 'SUCCESS')
      if (args[1].previousId !== undefined) record(args[1].previousId, 'REMOVED')
      return actual.markDeploymentLive(...args)
    },
    markLogsClosed: async (...args: Parameters<typeof actual.markLogsClosed>) => {
      if (closing.observe) closing.snapshots.set(args[1], await closing.observe(args[1]))
      const error = closing.error
      closing.error = undefined
      if (error) throw error
      return actual.markLogsClosed(...args)
    },
    loadDeploymentContext: async (...args: Parameters<typeof actual.loadDeploymentContext>) => {
      const error = loadFailure.error
      loadFailure.error = undefined
      if (error) throw error
      return actual.loadDeploymentContext(...args)
    },
  }
})

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instanceId: string
let environmentId: string

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  history.clear()
  closing.snapshots.clear()
  closing.error = undefined
  loadFailure.error = undefined
  await createProject(db, 'shop')
  const { instance } = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  instanceId = instance.id
  environmentId = instance.environmentId
  deps = fakeDeps(db)
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

async function get(id: string): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id))
  return row!
}

async function logRows(id: string): Promise<[string, string][]> {
  const rows = await db
    .select({ phase: deploymentLogs.phase, line: deploymentLogs.line })
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, id))
    .orderBy(asc(deploymentLogs.id))
  return rows.map((r) => [r.phase, r.line])
}

closing.observe = async (id) => {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id))
  const lines = await db.select({ line: deploymentLogs.line }).from(deploymentLogs).where(eq(deploymentLogs.deploymentId, id))
  return { status: row?.status ?? 'MISSING', closedAt: row?.logsClosedAt ?? null, lines: lines.map((l) => l.line) }
}

const logLines = async (id: string) => (await logRows(id)).map(([, line]) => line)
const statusHistory = async (id: string) => history.get(id) ?? ['QUEUED']
const nameOf = (d: { id: string }) => `vpsm-web-${d.id.slice(0, 8)}`
const tagOf = (d: { id: string }) => `vpsm/${instanceId}:${d.id}`

const queue = (trigger: DeploymentTrigger = 'manual', extra: { commitSha?: string; rollbackOfId?: string } = {}) =>
  enqueueDeployment(db, { serviceInstanceId: instanceId, trigger, ...extra })

async function setDeploy(partial: Partial<DeployConfig>): Promise<void> {
  await db
    .update(serviceInstances)
    .set({ deploy: { ...DEFAULT_DEPLOY_CONFIG, ...partial } })
    .where(eq(serviceInstances.id, instanceId))
}

/** Saves the memory limits an admin sets in the dashboard; they win over the worker's environment. */
async function saveResourceSettings(memoryBudgetMb: number, maxServiceMemoryMb: number): Promise<void> {
  const [admin] = await db
    .insert(users)
    .values({ email: `root-${randomUUID()}@example.com`, name: 'root', role: 'admin', passwordHash: 'x' })
    .returning({ id: users.id })
  await setResourceSettings(db, { memoryBudgetMb, maxServiceMemoryMb }, admin!.id)
}

/** A deployment that went live the way the pipeline does it; its container is running in FakeDocker unless `running: false`. */
async function liveDeployment(
  containerName: string,
  o: {
    imageTag?: string
    deploy?: Partial<DeployConfig>
    builder?: 'railpack' | 'dockerfile'
    commitSha?: string
    commitMessage?: string
    previousId?: string
    running?: boolean
  } = {},
): Promise<Deployment> {
  const [instance] = await db.select().from(serviceInstances).where(eq(serviceInstances.id, instanceId))
  const deploy = { ...instance!.deploy, ...o.deploy }
  const d = await queue()
  await setDeploymentStatus(db, d.id, 'BUILDING')
  await setDeploymentStatus(db, d.id, 'DEPLOYING', {
    commitSha: o.commitSha ?? 'old123',
    commitMessage: o.commitMessage ?? 'old commit',
    imageTag: o.imageTag ?? tagOf(d),
    configSnapshot: { source: instance!.source, build: instance!.build, deploy, builder: o.builder ?? 'railpack' },
  })
  await markDeploymentLive(db, { deploymentId: d.id, containerName, previousId: o.previousId })
  if (o.running ?? true) {
    deps.docker.seedRunning([{ name: containerName, memoryMb: deploy.memoryLimitMB, deploymentId: d.id, serviceInstanceId: instanceId }])
  }
  return get(d.id)
}

function silenceConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('happy path', () => {
  test('first deploy goes QUEUED → BUILDING → DEPLOYING → SUCCESS and routes', async () => {
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await statusHistory(d.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'])
    expect(deps.events).toEqual([
      'fetch',
      'build',
      'run vpsm-web-' + d.id.slice(0, 8),
      'health',
      `alias vpsm-web-${d.id.slice(0, 8)} web.internal`,
      // Attaching the alias reconnects the container to the network, so it is probed again.
      'health',
      'routes',
      'cleanup',
    ])
    expect(await get(d.id)).toMatchObject({
      status: 'SUCCESS',
      containerName: nameOf(d),
      commitSha: 'abc123',
      commitMessage: 'test commit',
      imageTag: tagOf(d),
      failureReason: null,
    })
    expect(deps.docker.has(nameOf(d))).toBe(true)
  })

  test('the deployment keeps a snapshot of the config it was built and run with', async () => {
    const d = await queue()
    await runDeployment(d.id, deps)
    expect((await get(d.id)).configSnapshot).toEqual({
      source: { repo: 'acme/web', branch: 'main' },
      build: { builder: 'auto' },
      deploy: DEFAULT_DEPLOY_CONFIG,
      builder: 'railpack',
    })
  })

  test('each step is announced in the deployment log', async () => {
    await setDeploy({ healthcheckPath: '/health' })
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await logRows(d.id)).toEqual([
      ['build', '==> Cloning acme/web@main'],
      ['build', '==> Building with railpack'],
      ['deploy', '==> Starting container'],
      ['deploy', '==> Healthcheck (http /health)'],
      ['deploy', '==> Healthcheck again after attaching web.internal'],
      ['deploy', '==> Live at https://web-shop.apps.example.com'],
    ])
  })

  test('source, builder choice, railpack plan and image build are wired from the service config', async () => {
    await db
      .update(serviceInstances)
      .set({
        source: { repo: 'acme/web', branch: 'release', rootDirectory: 'app' },
        build: { builder: 'auto', buildCommand: 'npm run build' },
        deploy: { ...DEFAULT_DEPLOY_CONFIG, startCommand: 'node server.js' },
      })
      .where(eq(serviceInstances.id, instanceId))
    const fetchSource = vi.fn(deps.fetchSource)
    const chooseBuilder = vi.fn(deps.chooseBuilder)
    const railpackPrepare = vi.fn(deps.railpackPrepare)
    const buildImage = vi.fn(deps.buildImage)
    Object.assign(deps, { fetchSource, chooseBuilder, railpackPrepare, buildImage })
    const sha = 'a'.repeat(40)
    const d = await queue('push', { commitSha: sha })

    await runDeployment(d.id, deps)

    const dir = path.join(deps.config.workDir, d.id)
    const contextDir = path.join(dir, 'src', 'app')
    expect(fetchSource).toHaveBeenCalledOnce()
    expect(fetchSource.mock.calls[0]![0]).toMatchObject({
      cloneUrl: 'https://github.com/acme/web.git',
      branch: 'release',
      commitSha: sha,
      rootDirectory: 'app',
      destDir: path.join(dir, 'src'),
      redact: [],
      run: deps.run,
    })
    expect(chooseBuilder).toHaveBeenCalledExactlyOnceWith(contextDir, { builder: 'auto', buildCommand: 'npm run build' })
    expect(railpackPrepare.mock.calls[0]![0]).toMatchObject({
      contextDir,
      outDir: dir,
      build: { builder: 'auto', buildCommand: 'npm run build' },
      startCommand: 'node server.js',
      run: deps.run,
      sleep: deps.sleep,
    })
    expect(buildImage.mock.calls[0]![0]).toMatchObject({
      builder: 'railpack',
      contextDir,
      planPath: path.join(dir, 'railpack-plan.json'),
      tag: tagOf(d),
      cacheKey: instanceId,
      frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0',
      timeoutMs: 1_200_000,
      run: deps.run,
    })
    // chooseBuilder is where a symlinked dockerfilePath escaping the repo is caught, so it must come first.
    expect(chooseBuilder.mock.invocationCallOrder[0]).toBeLessThan(buildImage.mock.invocationCallOrder[0]!)
    // railpack bakes the start command into the image.
    expect(deps.docker.lastSpec().Cmd).toBeUndefined()
  })

  test('a Dockerfile build skips railpack and runs the start command through sh', async () => {
    await db
      .update(serviceInstances)
      .set({
        build: { builder: 'dockerfile', dockerfilePath: 'docker/prod.Dockerfile' },
        deploy: { ...DEFAULT_DEPLOY_CONFIG, startCommand: 'node server.js' },
      })
      .where(eq(serviceInstances.id, instanceId))
    deps.chooseBuilder = async () => 'dockerfile'
    const railpackPrepare = vi.fn(deps.railpackPrepare)
    const buildImage = vi.fn(deps.buildImage)
    Object.assign(deps, { railpackPrepare, buildImage })
    const d = await queue()

    await runDeployment(d.id, deps)

    expect(railpackPrepare).not.toHaveBeenCalled()
    expect(buildImage.mock.calls[0]![0]).toMatchObject({ builder: 'dockerfile', dockerfilePath: 'docker/prod.Dockerfile', planPath: undefined })
    expect(deps.docker.lastSpec().Cmd).toEqual(['sh', '-c', 'node server.js'])
    expect((await get(d.id)).configSnapshot).toMatchObject({ builder: 'dockerfile' })
    expect(await logLines(d.id)).toContain('==> Building with dockerfile')
  })

  test('a Dockerfile build without a start command keeps the image CMD', async () => {
    deps.chooseBuilder = async () => 'dockerfile'
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(deps.docker.lastSpec().Cmd).toBeUndefined()
  })

  test('the container joins the project network with system env, gets its private alias; traefik and the worker join too', async () => {
    const d = await queue()
    await runDeployment(d.id, deps)
    const net = `vpsm-env-${environmentId}`
    expect(deps.docker.networks).toEqual(new Set([net]))
    expect(deps.docker.connections).toEqual([
      ['vpsm-traefik', net],
      ['vpsm-worker', net],
    ])
    expect(deps.docker.lastSpec()).toMatchObject({
      name: nameOf(d),
      Image: tagOf(d),
      Env: [
        'APP_PRIVATE_DOMAIN=web.internal',
        'APP_PROJECT_NAME=shop',
        'APP_PUBLIC_DOMAIN=web-shop.apps.example.com',
        'APP_SERVICE_NAME=web',
        'PORT=8080',
      ],
      Labels: { 'vpsm.deployment-id': d.id, 'vpsm.service-instance-id': instanceId, 'vpsm.memory-mb': '512' },
      HostConfig: { NetworkMode: net, Memory: 512 * 1024 * 1024, NanoCpus: 1e9 },
      // Created without the alias; it is attached once the container is healthy.
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [] } } },
    })
    expect(deps.docker.aliasesOf(nameOf(d), net)).toEqual(['web.internal'])
  })

  test('the private alias is attached only after the healthcheck passes', async () => {
    const net = `vpsm-env-${environmentId}`
    const aliasesDuringHealthcheck: (string[] | undefined)[] = []
    const realHealth = deps.waitHealthy
    deps.waitHealthy = async (target, options) => {
      aliasesDuringHealthcheck.push(deps.docker.aliasesOf(target.host, net))
      return realHealth(target, options)
    }
    const d = await queue()

    await runDeployment(d.id, deps)

    // Until then `web.internal` resolves only to the old container (if any), never to an unready one.
    // The second healthcheck runs after the reconnect that attached the alias.
    expect(aliasesDuringHealthcheck).toEqual([[], ['web.internal']])
    expect(deps.docker.aliasesOf(nameOf(d), net)).toEqual(['web.internal'])
    const e = deps.events
    expect(e.indexOf('health')).toBeLessThan(e.indexOf(`alias ${nameOf(d)} web.internal`))
    expect(e.lastIndexOf('health')).toBeGreaterThan(e.indexOf(`alias ${nameOf(d)} web.internal`))
    expect(e.lastIndexOf('health')).toBeLessThan(e.indexOf('routes'))
  })

  test('the public domain is the alphabetically first one', async () => {
    await db.insert(domains).values({ serviceInstanceId: instanceId, hostname: 'aaa.example.org', kind: 'custom' })
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(deps.docker.lastSpec().Env).toContain('APP_PUBLIC_DOMAIN=aaa.example.org')
    expect(await logLines(d.id)).toContain('==> Live at https://aaa.example.org')
  })

  test('the live log line carries the public HTTPS port when it is not 443', async () => {
    deps.config = { ...deps.config, publicHttpsPort: 8443 }
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await logLines(d.id)).toContain('==> Live at https://web-shop.apps.example.com:8443')
  })

  test('healthcheck probes the new container by name with the deploy settings', async () => {
    await setDeploy({ port: 3000, healthcheckTimeoutSec: 60 })
    const health = vi.fn(deps.waitHealthy)
    deps.waitHealthy = health
    const d = await queue()

    await runDeployment(d.id, deps)

    expect(health).toHaveBeenCalledTimes(2)
    const [target, options] = health.mock.calls[0]!
    expect(target).toEqual({ host: nameOf(d), port: 3000, path: undefined, mode: 'tcp' })
    expect(options.timeoutMs).toBe(60_000)
    deps.docker.setState(nameOf(d), { restartCount: 7 })
    expect((await options.state()).restartCount).toBe(7)
    expect(await logLines(d.id)).toContain('==> Healthcheck (tcp port 3000)')
    // After the alias reconnect: the same probe, for at most 30 s.
    const [againTarget, againOptions] = health.mock.calls[1]!
    expect(againTarget).toEqual(target)
    expect(againOptions.timeoutMs).toBe(30_000)
    expect((await againOptions.state()).restartCount).toBe(7)
  })

  test('the healthcheck after the alias reconnect keeps a shorter configured timeout', async () => {
    await setDeploy({ healthcheckPath: '/health', healthcheckTimeoutSec: 10 })
    const health = vi.fn(deps.waitHealthy)
    deps.waitHealthy = health
    const d = await queue()

    await runDeployment(d.id, deps)

    expect(health.mock.calls.map(([target, options]) => [target.mode, options.timeoutMs])).toEqual([
      ['http', 10_000],
      ['http', 10_000],
    ])
    expect((await get(d.id)).status).toBe('SUCCESS')
  })

  test('a service without a domain gets no public hostname and a running-only healthcheck', async () => {
    await db.delete(domains).where(eq(domains.serviceInstanceId, instanceId))
    const health = vi.fn(deps.waitHealthy)
    deps.waitHealthy = health
    const d = await queue()

    await runDeployment(d.id, deps)

    expect((await get(d.id)).status).toBe('SUCCESS')
    expect(deps.docker.lastSpec().Env).not.toContainEqual(expect.stringMatching(/^APP_PUBLIC_DOMAIN=/))
    expect(health.mock.calls[0]![0].mode).toBe('running')
    const lines = await logLines(d.id)
    expect(lines).toContain('==> Healthcheck (container keeps running)')
    expect(lines).toContain('==> Live (no public domain)')
  })
})

describe('redeploy', () => {
  test('redeploy switches routes before stopping the old container', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()

    await runDeployment(d2.id, deps)

    const e = deps.events
    expect(e.indexOf('routes')).toBeLessThan(e.indexOf('stop vpsm-web-old00000'))
    expect(e).toContain('sleep 3000')
    expect(e).toContain('sleep 10000')
    expect(e).toEqual([
      'fetch',
      'build',
      `run ${nameOf(d2)}`,
      'health',
      `alias ${nameOf(d2)} web.internal`,
      'health',
      'routes',
      'sleep 3000',
      'sleep 10000',
      'stop vpsm-web-old00000',
      'cleanup',
    ])
    expect((await get(previous.id)).status).toBe('REMOVED')
    expect(await statusHistory(d2.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'])
    expect(deps.docker.has('vpsm-web-old00000')).toBe(false)
    expect(deps.docker.has(nameOf(d2))).toBe(true)
  })

  test('the drain waits drainSeconds', async () => {
    deps.config = { ...deps.config, drainSeconds: 0 }
    await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()
    await runDeployment(d2.id, deps)
    expect(deps.events.filter((e) => e.startsWith('sleep '))).toEqual(['sleep 3000', 'sleep 0'])
  })

  test('a crashed previous deployment is replaced too', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    await setDeploymentStatus(db, previous.id, 'CRASHED', { failureReason: 'container exited with code 1' })
    deps.docker.setState('vpsm-web-old00000', { running: false, exitCode: 1 })
    const d2 = await queue()

    await runDeployment(d2.id, deps)

    expect((await get(d2.id)).status).toBe('SUCCESS')
    expect((await get(previous.id)).status).toBe('REMOVED')
    expect(deps.docker.has('vpsm-web-old00000')).toBe(false)
  })
})

describe('failures', () => {
  test('unhealthy app fails, old container keeps serving, new container removed', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()
    const newName = nameOf(d2)
    deps.waitHealthy = async () => ({ ok: false, reason: 'healthcheck timed out after 300s (last error: ECONNREFUSED)' })

    await runDeployment(d2.id, deps)

    expect(await get(d2.id)).toMatchObject({ status: 'FAILED', failureReason: 'healthcheck timed out after 300s (last error: ECONNREFUSED)' })
    expect((await get(previous.id)).status).toBe('SUCCESS')
    expect(deps.events).not.toContain('routes')
    expect(deps.events.some((e) => e.startsWith('alias '))).toBe(false)
    expect(deps.docker.has('vpsm-web-old00000')).toBe(true)
    expect(deps.docker.has(newName)).toBe(false)
    expect(deps.events).toContain(`stop ${newName}`)
    expect(await statusHistory(d2.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'FAILED'])
    expect(await logLines(d2.id)).toContain('==> Deployment failed: healthcheck timed out after 300s (last error: ECONNREFUSED)')
  })

  test('a failed healthcheck after the alias reconnect fails the deployment, old container keeps serving', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()
    const newName = nameOf(d2)
    let probes = 0
    deps.waitHealthy = async () => {
      deps.events.push('health')
      return ++probes === 1 ? { ok: true } : { ok: false, reason: 'healthcheck timed out after 30s (last error: ECONNREFUSED)' }
    }

    await runDeployment(d2.id, deps)

    expect(await get(d2.id)).toMatchObject({ status: 'FAILED', failureReason: 'healthcheck timed out after 30s (last error: ECONNREFUSED)' })
    expect(await statusHistory(d2.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'FAILED'])
    expect(deps.events).toEqual(['fetch', 'build', `run ${newName}`, 'health', `alias ${newName} web.internal`, 'health', `stop ${newName}`])
    expect(deps.docker.has(newName)).toBe(false)
    expect((await get(previous.id)).status).toBe('SUCCESS')
    expect(deps.docker.has('vpsm-web-old00000')).toBe(true)
    expect(await logLines(d2.id)).toContain('==> Deployment failed: healthcheck timed out after 30s (last error: ECONNREFUSED)')
  })

  test('build failure stops before any container is created', async () => {
    const d = await queue()
    deps.buildImage = async () => {
      throw new BuildError('image build failed (exit code 1)')
    }
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'image build failed (exit code 1)' })
    expect(deps.events.some((e) => e.startsWith('run '))).toBe(false)
    expect(await statusHistory(d.id)).toEqual(['QUEUED', 'BUILDING', 'FAILED'])
    expect(await logRows(d.id)).toContainEqual(['build', '==> Deployment failed: image build failed (exit code 1)'])
  })

  test('a source failure is reported with its own message', async () => {
    const d = await queue()
    deps.fetchSource = async () => {
      throw new SourceError('git clone failed (exit code 128)')
    }
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'git clone failed (exit code 128)' })
    expect(await statusHistory(d.id)).toEqual(['QUEUED', 'BUILDING', 'FAILED'])
  })

  test('memory budget is checked before cloning', async () => {
    const d = await queue()
    deps.docker.seedRunning([{ memoryMb: 2048 }, { memoryMb: 2048 }, { memoryMb: 1280 }])
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory budget exceeded: need 512 MB, available 256 MB' })
    expect(deps.events).not.toContain('fetch')
    expect(deps.events).toEqual([])
    expect(await statusHistory(d.id)).toEqual(['QUEUED', 'FAILED'])
  })

  test('stopped containers do not count against the memory budget', async () => {
    deps.docker.seedRunning([{ memoryMb: 2048 }, { memoryMb: 2048 }, { memoryMb: 1280, name: 'vpsm-stopped' }])
    deps.docker.setState('vpsm-stopped', { running: false })
    const d = await queue()
    await runDeployment(d.id, deps)
    expect((await get(d.id)).status).toBe('SUCCESS')
  })

  test('a memory limit above the per-service max is refused before cloning', async () => {
    await setDeploy({ memoryLimitMB: 4096 })
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory limit 4096 MB exceeds per-service max 2048 MB' })
    expect(deps.events).toEqual([])
  })

  test('memory budget from settings overrides env', async () => {
    await saveResourceSettings(1024, 512)
    deps.docker.seedRunning([{ memoryMb: 1024 }])
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory budget exceeded: need 512 MB, available 0 MB' })
    expect(deps.events).toEqual([])
  })

  test('a bigger memory budget from settings lets through what the env budget would refuse', async () => {
    // The env budget is 5632 MB, so 5376 MB in use leaves 256 MB and the 512 MB service would not fit.
    deps.docker.seedRunning([{ memoryMb: 2048 }, { memoryMb: 2048 }, { memoryMb: 1280 }])
    await saveResourceSettings(8192, 2048)
    const d = await queue()
    await runDeployment(d.id, deps)
    expect((await get(d.id)).status).toBe('SUCCESS')
  })

  test('the per-service max from settings overrides env, in both directions', async () => {
    await saveResourceSettings(8192, 256)
    const refused = await queue()
    await runDeployment(refused.id, deps)
    expect(await get(refused.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory limit 512 MB exceeds per-service max 256 MB' })
    expect(deps.events).toEqual([])

    // The env max is 2048 MB, so 4096 MB would be refused without the setting.
    await saveResourceSettings(8192, 4096)
    await setDeploy({ memoryLimitMB: 4096 })
    const allowed = await queue()
    await runDeployment(allowed.id, deps)
    expect((await get(allowed.id)).status).toBe('SUCCESS')
  })

  test('the settings are read again for every deployment', async () => {
    const first = await queue()
    await runDeployment(first.id, deps)
    expect((await get(first.id)).status).toBe('SUCCESS')

    // The first deployment's container uses 512 MB, which now fills the whole budget.
    await saveResourceSettings(512, 512)
    const second = await queue()
    await runDeployment(second.id, deps)
    expect(await get(second.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory budget exceeded: need 512 MB, available 0 MB' })
  })

  test.each([
    [{ cpuLimit: 0 }, 'invalid CPU limit: 0 (must be at least 0.01)'],
    [{ memoryLimitMB: 5 }, 'invalid memory limit: 5 MB (must be an integer of at least 6)'],
    [{ memoryLimitMB: 256.5 }, 'invalid memory limit: 256.5 MB (must be an integer of at least 6)'],
  ] as const)('an invalid resource limit %o is refused before cloning', async (limits, reason) => {
    await setDeploy(limits)
    const d = await queue()
    await runDeployment(d.id, deps)
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: reason })
    expect(deps.events).toEqual([])
    expect(await deps.docker.listManaged()).toEqual([])
    expect(await statusHistory(d.id)).toEqual(['QUEUED', 'FAILED'])
  })

  test('a rollback to a snapshot with an invalid resource limit is refused before any container runs', async () => {
    const old = await liveDeployment('vpsm-web-old00000', { imageTag: 'vpsm/si:old', deploy: { cpuLimit: 0.001 }, running: false })
    deps.docker.existingImages.add('vpsm/si:old')
    const rb = await queue('rollback', { rollbackOfId: old.id })
    await runDeployment(rb.id, deps)
    expect(await get(rb.id)).toMatchObject({ status: 'FAILED', failureReason: 'invalid CPU limit: 0.001 (must be at least 0.01)' })
    expect(deps.events).toEqual([])
    expect(await statusHistory(rb.id)).toEqual(['QUEUED', 'FAILED'])
  })

  test('a docker error during the healthcheck fails as an internal error and removes the new container', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    deps.waitHealthy = waitHealthy // the real one, which asks docker for the container state first
    vi.spyOn(deps.docker, 'state').mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'))
    const d2 = await queue()

    await runDeployment(d2.id, deps)

    expect(await get(d2.id)).toMatchObject({ status: 'FAILED', failureReason: 'internal error: connect ENOENT /var/run/docker.sock' })
    expect(deps.docker.has(nameOf(d2))).toBe(false)
    expect(deps.events).toContain(`stop ${nameOf(d2)}`)
    expect(deps.events).not.toContain('routes')
    expect((await get(previous.id)).status).toBe('SUCCESS')
    expect(deps.docker.has('vpsm-web-old00000')).toBe(true)
  })

  test('a failure to attach the private alias fails the deployment and removes the new container', async () => {
    const previous = await liveDeployment('vpsm-web-old00000')
    vi.spyOn(deps.docker, 'attachAlias').mockRejectedValue(new Error('network vpsm-env-x not found'))
    const d2 = await queue()

    await runDeployment(d2.id, deps)

    expect(await get(d2.id)).toMatchObject({ status: 'FAILED', failureReason: 'internal error: network vpsm-env-x not found' })
    expect(await statusHistory(d2.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'FAILED'])
    expect(deps.docker.has(nameOf(d2))).toBe(false)
    expect(deps.events).toContain(`stop ${nameOf(d2)}`)
    expect(deps.events).not.toContain('routes')
    expect((await get(previous.id)).status).toBe('SUCCESS')
    expect(deps.docker.has('vpsm-web-old00000')).toBe(true)
  })

  test('writing the routes is retried before the old container is stopped', async () => {
    await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()
    let attempts = 0
    deps.regenerateRoutes = async () => {
      attempts++
      if (attempts < 3) throw new Error(`EBUSY attempt ${attempts}`)
      deps.events.push('routes')
    }

    await runDeployment(d2.id, deps)

    expect(attempts).toBe(3)
    expect(deps.events.slice(deps.events.indexOf(`alias ${nameOf(d2)} web.internal`) + 1)).toEqual([
      'health',
      'sleep 1000',
      'sleep 2000',
      'routes',
      'sleep 3000',
      'sleep 10000',
      'stop vpsm-web-old00000',
      'cleanup',
    ])
    expect((await get(d2.id)).status).toBe('SUCCESS')
    const lines = await logLines(d2.id)
    expect(lines).toContain('==> Updating routes failed, retrying in 1s: EBUSY attempt 1')
    expect(lines).toContain('==> Updating routes failed, retrying in 2s: EBUSY attempt 2')
    expect(lines).toContain('==> Live at https://web-shop.apps.example.com')
  })

  test('a failure after going live leaves the deployment live and does not stop the old container', async () => {
    await liveDeployment('vpsm-web-old00000')
    const d2 = await queue()
    let attempts = 0
    deps.regenerateRoutes = async () => {
      attempts++
      throw new Error('EACCES: permission denied')
    }
    const error = silenceConsoleError()
    try {
      await runDeployment(d2.id, deps)
      expect(attempts).toBe(3)
      expect(deps.events.filter((e) => e.startsWith('sleep '))).toEqual(['sleep 1000', 'sleep 2000'])
      expect(await statusHistory(d2.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'])
      expect(await get(d2.id)).toMatchObject({ status: 'SUCCESS', failureReason: null })
      expect(deps.docker.has(nameOf(d2))).toBe(true)
      // Traefik may still point at the old container, so it keeps running.
      expect(deps.docker.has('vpsm-web-old00000')).toBe(true)
      expect(deps.events.some((e) => e.startsWith('stop '))).toBe(false)
      expect(await logLines(d2.id)).toContain('==> Post-deploy step failed: internal error: EACCES: permission denied')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('EACCES: permission denied'))
    } finally {
      error.mockRestore()
    }
  })

  test('a deployment that is no longer queued is left alone', async () => {
    const d = await queue()
    await setDeploymentStatus(db, d.id, 'SKIPPED')
    const error = silenceConsoleError()
    try {
      await runDeployment(d.id, deps)
      expect(deps.events).toEqual([])
      expect(await statusHistory(d.id)).toEqual(['QUEUED', 'SKIPPED'])
      expect(error).toHaveBeenCalledWith(expect.stringContaining('SKIPPED'))
    } finally {
      error.mockRestore()
    }
  })

  test('a deployment whose context cannot be loaded is marked FAILED instead of staying claimed', async () => {
    const d = await queue()
    expect((await claimNextDeployment(db))?.id).toBe(d.id)
    loadFailure.error = new Error('Connection terminated unexpectedly')
    const error = silenceConsoleError()
    try {
      await runDeployment(d.id, deps)
      expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'internal error: Connection terminated unexpectedly' })
      expect(await statusHistory(d.id)).toEqual(['QUEUED', 'FAILED'])
      expect(deps.events).toEqual([])
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Connection terminated unexpectedly'))
    } finally {
      error.mockRestore()
    }
  })

  test('an unknown deployment is reported, not thrown', async () => {
    const error = silenceConsoleError()
    try {
      await expect(runDeployment(randomUUID(), deps)).resolves.toBeUndefined()
      expect(deps.events).toEqual([])
      expect(error).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
    }
  })
})

// A deployment's status can be final while its log is still being written: SUCCESS is set before the lines about
// going live and stopping the old container, FAILED before the failure line reaches the database. So the worker
// says when the log is complete (`logsClosedAt`), after its last line, and readers of the log wait for that.
describe('closing the log', () => {
  test('is left open while the deployment runs, and is closed afterwards', async () => {
    const d = await queue()
    const seen: (Date | null)[] = []
    deps.waitHealthy = async () => {
      seen.push((await get(d.id)).logsClosedAt)
      return { ok: true }
    }
    await runDeployment(d.id, deps)
    expect(seen).toEqual([null, null])
    expect((await get(d.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('on success it is closed after every line, including the ones written after SUCCESS was set', async () => {
    await liveDeployment('vpsm-web-old00000')
    const d = await queue()
    let atStop: { status: string; closedAt: Date | null } | undefined
    const stop = deps.docker.stopAndRemove.bind(deps.docker)
    deps.docker.stopAndRemove = async (...args) => {
      const row = await get(d.id)
      atStop = { status: row.status, closedAt: row.logsClosedAt }
      return stop(...args)
    }
    await runDeployment(d.id, deps)

    // The window in which a reader used to be told "finished": live, with the log still open.
    expect(atStop).toEqual({ status: 'SUCCESS', closedAt: null })
    const snapshot = closing.snapshots.get(d.id)!
    expect(snapshot.status).toBe('SUCCESS')
    expect(snapshot.closedAt).toBeNull()
    expect(snapshot.lines).toEqual(await logLines(d.id))
    expect(snapshot.lines.at(-1)).toBe('==> Stopping previous container vpsm-web-old00000')
    expect(snapshot.lines).toContain('==> Live at https://web-shop.apps.example.com')
    expect((await get(d.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('on failure it is closed after the failure line and the FAILED status', async () => {
    const d = await queue()
    deps.waitHealthy = async () => ({ ok: false, reason: 'healthcheck timed out' })
    await runDeployment(d.id, deps)

    const snapshot = closing.snapshots.get(d.id)!
    expect(snapshot.status).toBe('FAILED')
    expect(snapshot.closedAt).toBeNull()
    expect(snapshot.lines.at(-1)).toBe('==> Deployment failed: healthcheck timed out')
    expect(snapshot.lines).toEqual(await logLines(d.id))
    expect((await get(d.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('a build failure closes it too', async () => {
    const d = await queue()
    deps.buildImage = async () => {
      throw new BuildError('docker build failed (exit code 1)')
    }
    await runDeployment(d.id, deps)
    expect(closing.snapshots.get(d.id)).toMatchObject({ status: 'FAILED', closedAt: null })
    expect(closing.snapshots.get(d.id)!.lines.at(-1)).toBe('==> Deployment failed: docker build failed (exit code 1)')
    expect((await get(d.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('a step that fails after going live closes it after the failure line', async () => {
    const d = await queue()
    deps.regenerateRoutes = async () => {
      throw new Error('EACCES: permission denied')
    }
    const error = silenceConsoleError()
    try {
      await runDeployment(d.id, deps)
    } finally {
      error.mockRestore()
    }
    expect(closing.snapshots.get(d.id)!.lines.at(-1)).toBe('==> Post-deploy step failed: internal error: EACCES: permission denied')
    expect((await get(d.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('a rollback and a restart close it like any deployment', async () => {
    const live = await liveDeployment('vpsm-web-old00000')
    const rollback = await queue('rollback', { rollbackOfId: live.id })
    await runDeployment(rollback.id, deps)
    const restart = await queue('restart', { rollbackOfId: rollback.id })
    await runDeployment(restart.id, deps)
    expect((await get(rollback.id)).logsClosedAt).toBeInstanceOf(Date)
    expect((await get(restart.id)).logsClosedAt).toBeInstanceOf(Date)
  })

  test('a deployment whose context cannot be loaded has no log to wait for: it is closed', async () => {
    const d = await queue()
    expect((await claimNextDeployment(db))?.id).toBe(d.id)
    loadFailure.error = new Error('Connection terminated unexpectedly')
    const error = silenceConsoleError()
    try {
      await runDeployment(d.id, deps)
    } finally {
      error.mockRestore()
    }
    expect(await get(d.id)).toMatchObject({ status: 'FAILED', logsClosedAt: expect.any(Date) })
  })

  test('a deployment that is not queued is not touched', async () => {
    const d = await queue()
    await setDeploymentStatus(db, d.id, 'SKIPPED')
    const error = silenceConsoleError()
    try {
      await runDeployment(d.id, deps)
    } finally {
      error.mockRestore()
    }
    expect((await get(d.id)).logsClosedAt).toBeNull()
    expect(closing.snapshots.has(d.id)).toBe(false)
  })

  test('failing to close it is reported without the message of the database, and changes nothing else', async () => {
    const d = await queue()
    closing.error = new Error('connection lost\nparams: ' + d.id)
    const error = silenceConsoleError()
    try {
      await expect(runDeployment(d.id, deps)).resolves.toBeUndefined()
      expect(await get(d.id)).toMatchObject({ status: 'SUCCESS', logsClosedAt: null })
      const reported = error.mock.calls.map((call) => String(call[0])).join('\n')
      expect(reported).toContain('could not close its log')
      expect(reported).not.toContain('params:')
    } finally {
      error.mockRestore()
    }
  })
})

describe('rollback', () => {
  const snapshotDeploy = { port: 3000, memoryLimitMB: 256, healthcheckPath: '/old-health', healthcheckTimeoutSec: 30, startCommand: 'node old.js' }

  // old (image vpsm/si:old) was live, then replaced by current; rb rolls back to old.
  async function rollbackScenario() {
    const old = await liveDeployment('vpsm-web-old00000', {
      imageTag: 'vpsm/si:old',
      commitSha: 'old123',
      commitMessage: 'old commit',
      deploy: snapshotDeploy,
      builder: 'dockerfile',
      running: false,
    })
    const current = await liveDeployment('vpsm-web-cur00000', { previousId: old.id, commitSha: 'cur456' })
    const rb = await queue('rollback', { rollbackOfId: old.id })
    return { old, current, rb }
  }

  test('rollback reuses the old image without building', async () => {
    const { current, rb } = await rollbackScenario()
    deps.docker.existingImages.add('vpsm/si:old')

    await runDeployment(rb.id, deps)

    expect(deps.events).not.toContain('build')
    expect(deps.events).not.toContain('fetch')
    expect(deps.docker.lastSpec().Image).toBe('vpsm/si:old')
    expect((await get(rb.id)).status).toBe('SUCCESS')
    expect(deps.events).toEqual([
      `run ${nameOf(rb)}`,
      'health',
      `alias ${nameOf(rb)} web.internal`,
      'health',
      'routes',
      'sleep 3000',
      'sleep 10000',
      'stop vpsm-web-cur00000',
      'cleanup',
    ])
    expect(await statusHistory(rb.id)).toEqual(['QUEUED', 'DEPLOYING', 'SUCCESS'])
    expect((await get(current.id)).status).toBe('REMOVED')
  })

  test('rollback records the image, commit and config snapshot of its target', async () => {
    const { old, rb } = await rollbackScenario()
    deps.docker.existingImages.add('vpsm/si:old')

    await runDeployment(rb.id, deps)

    expect(await get(rb.id)).toMatchObject({
      status: 'SUCCESS',
      imageTag: 'vpsm/si:old',
      commitSha: 'old123',
      commitMessage: 'old commit',
      configSnapshot: old.configSnapshot,
      containerName: nameOf(rb),
    })
    expect(await logLines(rb.id)).toContain(`==> Rolling back to deployment ${old.id.slice(0, 8)} (image vpsm/si:old)`)
  })

  test('rollback runs with the deploy config of its snapshot, not the current one', async () => {
    const { rb } = await rollbackScenario()
    deps.docker.existingImages.add('vpsm/si:old')
    // current (512 MB) + 4864 MB = 5376 MB used, 256 MB left: the snapshot's 256 MB fits, today's 512 MB would not.
    deps.docker.seedRunning([{ memoryMb: 4864 }])
    const health = vi.fn(deps.waitHealthy)
    deps.waitHealthy = health

    await runDeployment(rb.id, deps)

    expect((await get(rb.id)).status).toBe('SUCCESS')
    const spec = deps.docker.lastSpec()
    expect(spec.Env).toContain('PORT=3000')
    expect(spec.HostConfig?.Memory).toBe(256 * 1024 * 1024)
    expect(spec.Cmd).toEqual(['sh', '-c', 'node old.js'])
    expect(health.mock.calls.map(([target]) => target)).toEqual([
      { host: nameOf(rb), port: 3000, path: '/old-health', mode: 'http' },
      { host: nameOf(rb), port: 3000, path: '/old-health', mode: 'http' },
    ])
    expect(health.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([30_000, 30_000])
  })

  test('rollback fails clearly when image was cleaned up', async () => {
    const { current, rb } = await rollbackScenario()

    await runDeployment(rb.id, deps)

    expect(await get(rb.id)).toMatchObject({ status: 'FAILED', failureReason: 'image for rollback target no longer exists' })
    expect(deps.events).toEqual([])
    expect(await statusHistory(rb.id)).toEqual(['QUEUED', 'FAILED'])
    expect((await get(current.id)).status).toBe('SUCCESS')
  })

  test('rollback to a deployment that never built an image fails clearly', async () => {
    const failed = await queue()
    await setDeploymentStatus(db, failed.id, 'BUILDING')
    await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'image build failed (exit code 1)' })
    const rb = await queue('rollback', { rollbackOfId: failed.id })

    await runDeployment(rb.id, deps)

    expect(await get(rb.id)).toMatchObject({ status: 'FAILED', failureReason: 'rollback target has no built image' })
    expect(deps.events).toEqual([])
  })

  test('a rollback without a target fails clearly', async () => {
    const rb = await queue('rollback')
    await runDeployment(rb.id, deps)
    expect(await get(rb.id)).toMatchObject({ status: 'FAILED', failureReason: 'rollback target not found' })
  })

  test("a rollback to another service's deployment is refused before anything runs", async () => {
    const { instance: api } = await createAppService(db, {
      projectName: 'shop',
      serviceName: 'api',
      source: { repo: 'acme/api', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    const foreign = await enqueueDeployment(db, { serviceInstanceId: api.id, trigger: 'manual' })
    await setDeploymentStatus(db, foreign.id, 'BUILDING')
    await setDeploymentStatus(db, foreign.id, 'DEPLOYING', {
      imageTag: 'vpsm/api:image',
      configSnapshot: { source: api.source, build: api.build, deploy: api.deploy, builder: 'railpack' },
    })
    await markDeploymentLive(db, { deploymentId: foreign.id, containerName: 'vpsm-api-live0000' })
    deps.docker.existingImages.add('vpsm/api:image')
    const rb = await queue('rollback', { rollbackOfId: foreign.id })

    await runDeployment(rb.id, deps)

    expect(await get(rb.id)).toMatchObject({ status: 'FAILED', failureReason: 'rollback target belongs to another service' })
    expect(deps.events).toEqual([])
    expect(await statusHistory(rb.id)).toEqual(['QUEUED', 'FAILED'])
    expect((await get(foreign.id)).status).toBe('SUCCESS')
  })
})

describe('restart', () => {
  const liveDeploy = { port: 3000, memoryLimitMB: 256, healthcheckPath: '/live-health', healthcheckTimeoutSec: 30, startCommand: 'node live.js' }

  // A restart is queued with the live deployment as its rollbackOfId; its image is what runs again.
  async function restartScenario() {
    const live = await liveDeployment('vpsm-web-live0000', {
      imageTag: 'vpsm/si:live',
      commitSha: 'live123',
      commitMessage: 'live commit',
      deploy: liveDeploy,
      builder: 'dockerfile',
    })
    deps.docker.existingImages.add('vpsm/si:live')
    const rs = await queue('restart', { rollbackOfId: live.id })
    return { live, rs }
  }

  test('restart reuses the live image without building', async () => {
    const { live, rs } = await restartScenario()

    await runDeployment(rs.id, deps)

    expect(deps.events).not.toContain('fetch')
    expect(deps.events).not.toContain('build')
    expect(deps.docker.lastSpec().Image).toBe(live.imageTag)
    expect(deps.events).toEqual([
      `run ${nameOf(rs)}`,
      'health',
      `alias ${nameOf(rs)} web.internal`,
      'health',
      'routes',
      'sleep 3000',
      'sleep 10000',
      'stop vpsm-web-live0000',
      'cleanup',
    ])
    expect(await statusHistory(rs.id)).toEqual(['QUEUED', 'DEPLOYING', 'SUCCESS'])
    expect((await get(rs.id)).status).toBe('SUCCESS')
    expect((await get(live.id)).status).toBe('REMOVED')
  })

  test('restart records the image, commit and config snapshot of the live deployment', async () => {
    const { live, rs } = await restartScenario()

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({
      status: 'SUCCESS',
      trigger: 'restart',
      imageTag: 'vpsm/si:live',
      commitSha: 'live123',
      commitMessage: 'live commit',
      configSnapshot: live.configSnapshot,
      containerName: nameOf(rs),
    })
    expect(await logLines(rs.id)).toContain(`==> Restarting deployment ${live.id.slice(0, 8)} (image vpsm/si:live)`)
  })

  test('restart runs with the config snapshot of the live deployment, not the current service config', async () => {
    const { rs } = await restartScenario()
    // Saved without deploying: a restart must not pick this up.
    await setDeploy({ port: 9000, memoryLimitMB: 1024, healthcheckPath: '/new-health' })

    await runDeployment(rs.id, deps)

    expect((await get(rs.id)).status).toBe('SUCCESS')
    const spec = deps.docker.lastSpec()
    expect(spec.Env).toContain('PORT=3000')
    expect(spec.HostConfig?.Memory).toBe(256 * 1024 * 1024)
    expect(spec.Cmd).toEqual(['sh', '-c', 'node live.js'])
  })

  test('restart is checked against the memory settings like any deployment', async () => {
    const { live, rs } = await restartScenario()
    // The live container (256 MB) is still running next to the new one, so both have to fit.
    await saveResourceSettings(400, 256)

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory budget exceeded: need 256 MB, available 144 MB' })
    expect(deps.events).toEqual([])
    expect((await get(live.id)).status).toBe('SUCCESS')
  })

  test('a restart whose image is gone fails and leaves the live deployment alone', async () => {
    const { live, rs } = await restartScenario()
    deps.docker.existingImages.delete('vpsm/si:live')

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'FAILED', failureReason: 'image of the running deployment no longer exists' })
    expect(deps.events).toEqual([])
    expect((await get(live.id)).status).toBe('SUCCESS')
    expect(deps.docker.has('vpsm-web-live0000')).toBe(true)
  })

  test('a restart with nothing running fails clearly instead of building', async () => {
    const rs = await queue('restart')

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'FAILED', failureReason: 'nothing is running to restart' })
    expect(deps.events).toEqual([])
    expect(await statusHistory(rs.id)).toEqual(['QUEUED', 'FAILED'])
  })

  test('a restart whose named deployment is no longer live has nothing to restart', async () => {
    const { live, rs } = await restartScenario()
    await setDeploymentStatus(db, live.id, 'REMOVED')

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'FAILED', failureReason: 'nothing is running to restart' })
    expect(deps.events).toEqual([])
  })

  test('a restart of a live deployment without an image fails clearly', async () => {
    const { live, rs } = await restartScenario()
    await db.update(deployments).set({ imageTag: null }).where(eq(deployments.id, live.id))

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'FAILED', failureReason: 'the running deployment has no built image' })
    expect(deps.events).toEqual([])
  })

  test('a restart also runs when the live deployment has crashed', async () => {
    const { live, rs } = await restartScenario()
    await setDeploymentStatus(db, live.id, 'CRASHED')

    await runDeployment(rs.id, deps)

    expect(await get(rs.id)).toMatchObject({ status: 'SUCCESS', imageTag: 'vpsm/si:live' })
    expect((await get(live.id)).status).toBe('REMOVED')
  })

  test('a restart restarts what is live when it runs, not what was live when it was queued', async () => {
    const a = await liveDeployment('vpsm-web-aaaa0000', { imageTag: 'vpsm/si:a', commitSha: 'aaa', deploy: liveDeploy, builder: 'dockerfile' })
    // B is being deployed while the user clicks Restart: the restart is queued behind it and names A.
    const b = await queue()
    await setDeploymentStatus(db, b.id, 'BUILDING')
    const rs = await queue('restart', { rollbackOfId: a.id })
    const bDeploy = { ...(a.configSnapshot as { deploy: DeployConfig }).deploy, port: 4000, memoryLimitMB: 128, startCommand: 'node b.js' }
    await setDeploymentStatus(db, b.id, 'DEPLOYING', {
      commitSha: 'bbb',
      commitMessage: 'newer commit',
      imageTag: 'vpsm/si:b',
      configSnapshot: { ...(a.configSnapshot as object), deploy: bDeploy },
    })
    await markDeploymentLive(db, { deploymentId: b.id, containerName: 'vpsm-web-bbbb0000', previousId: a.id })
    deps.docker.seedRunning([{ name: 'vpsm-web-bbbb0000', memoryMb: 128, deploymentId: b.id, serviceInstanceId: instanceId }])
    deps.docker.existingImages.add('vpsm/si:a')
    deps.docker.existingImages.add('vpsm/si:b')

    await runDeployment(rs.id, deps)

    // It ran B's image with B's config and retired B's container; A did not come back.
    const spec = deps.docker.lastSpec()
    expect(spec.Image).toBe('vpsm/si:b')
    expect(spec.Env).toContain('PORT=4000')
    expect(spec.Cmd).toEqual(['sh', '-c', 'node b.js'])
    expect(deps.events).toContain('stop vpsm-web-bbbb0000')
    expect(deps.events).not.toContain('stop vpsm-web-aaaa0000')
    expect(await get(rs.id)).toMatchObject({
      status: 'SUCCESS',
      imageTag: 'vpsm/si:b',
      commitSha: 'bbb',
      commitMessage: 'newer commit',
      configSnapshot: (await get(b.id)).configSnapshot,
      rollbackOfId: a.id,
    })
    expect((await get(b.id)).status).toBe('REMOVED')
    expect((await get(a.id)).status).toBe('REMOVED')
    expect(await logLines(rs.id)).toContain(`==> Restarting deployment ${b.id.slice(0, 8)} (image vpsm/si:b)`)
  })
})

describe('work directory and secrets', () => {
  test('work directory is removed after success and after failure', async () => {
    const ok = await queue()
    const realBuild = deps.buildImage
    let clonedDuringBuild = false
    deps.buildImage = async (i) => {
      clonedDuringBuild = fs.existsSync(path.join(deps.config.workDir, ok.id, 'src', 'index.js'))
      return realBuild(i)
    }
    await runDeployment(ok.id, deps)
    expect(clonedDuringBuild).toBe(true)
    expect(fs.existsSync(path.join(deps.config.workDir, ok.id))).toBe(false)

    // A clone that fails halfway leaves files behind (possibly the token in .git/config).
    const bad = await queue()
    deps.fetchSource = async (i) => {
      fs.mkdirSync(path.join(i.destDir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(i.destDir, '.git', 'config'), `url = ${i.cloneUrl}\n`)
      throw new SourceError('git remote failed (exit code 1)')
    }
    await runDeployment(bad.id, deps)
    expect((await get(bad.id)).status).toBe('FAILED')
    expect(fs.existsSync(path.join(deps.config.workDir, bad.id))).toBe(false)
  })
})
