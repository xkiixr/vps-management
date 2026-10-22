import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  appendDeploymentLogs,
  createAppService,
  createProject,
  type Deployment,
  deployments,
  domains,
  enqueueDeployment,
  findServiceInstance,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { runCli } from '../src/cli'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let out: string[]

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  out = []
  deps = fakeDeps(db)
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

const cli = (...argv: string[]) => runCli(argv, { db, docker: deps.docker, config: deps.config, out: (line) => out.push(line) })

async function instanceOf(project: string, service: string) {
  const found = await findServiceInstance(db, project, service)
  if (!found) throw new Error(`no ${project}/${service}`)
  return found
}

async function deploymentsOf(project: string, service: string): Promise<Deployment[]> {
  const { instance } = await instanceOf(project, service)
  return db.select().from(deployments).where(eq(deployments.serviceInstanceId, instance.id)).orderBy(desc(deployments.createdAt), desc(deployments.id))
}

async function addService(project: string, service: string) {
  const { instance } = await createAppService(db, {
    projectName: project,
    serviceName: service,
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: deps.config.appsDomain,
  })
  return instance
}

async function addProjectWithService(project = 'shop', service = 'web') {
  await createProject(db, project)
  return addService(project, service)
}

/** Takes a new deployment of the instance through the pipeline's states up to SUCCESS. */
async function succeeded(serviceInstanceId: string, containerName: string): Promise<Deployment> {
  const queued = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await setDeploymentStatus(db, queued.id, 'BUILDING')
  await setDeploymentStatus(db, queued.id, 'DEPLOYING', { imageTag: `vpsm/${serviceInstanceId}:${queued.id}` })
  await markDeploymentLive(db, { deploymentId: queued.id, containerName })
  return (await db.select().from(deployments).where(eq(deployments.id, queued.id)))[0]!
}

const usageLines = () => out.filter((line) => line.startsWith('usage') || line.startsWith('  '))

describe('project:create', () => {
  test('creates the project', async () => {
    expect(await cli('project:create', 'shop')).toBe(0)
    expect(out).toEqual(['created project shop'])
  })

  test('invalid names return exit 1 with message', async () => {
    expect(await cli('project:create', 'My Shop')).toBe(1)
    expect(out.at(-1)).toMatch(/^error: /)
  })

  test('a duplicate project returns exit 1 with message', async () => {
    await cli('project:create', 'shop')
    out.length = 0
    expect(await cli('project:create', 'shop')).toBe(1)
    expect(out).toEqual(['error: project "shop" already exists'])
  })
})

describe('service:create', () => {
  test('creates, enqueues and prints the URL', async () => {
    await cli('project:create', 'shop')
    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', '256')).toBe(0)
    expect(out).toContain('https://web-shop.apps.example.com')
    expect((await deploymentsOf('shop', 'web'))[0]).toMatchObject({ status: 'QUEUED', trigger: 'manual' })
    expect((await instanceOf('shop', 'web')).instance.deploy.memoryLimitMB).toBe(256)
  })

  test('prints the id of the queued deployment', async () => {
    await createProject(db, 'shop')
    await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main')
    const [queued] = await deploymentsOf('shop', 'web')
    expect(out).toEqual(['https://web-shop.apps.example.com', `queued deployment ${queued!.id}`])
  })

  test('maps the flags onto the source and deploy configuration', async () => {
    await cli('project:create', 'shop')
    const code = await cli(
      'service:create', 'shop', 'web',
      '--repo', 'acme/web', '--branch', 'release', '--root', 'apps/web',
      '--healthcheck', '/up', '--port', '3000', '--memory', '1024', '--start', 'node server.js',
    )
    expect(code).toBe(0)
    const { instance } = await instanceOf('shop', 'web')
    expect(instance.source).toEqual({ repo: 'acme/web', branch: 'release', rootDirectory: 'apps/web' })
    expect(instance.deploy).toMatchObject({ healthcheckPath: '/up', port: 3000, memoryLimitMB: 1024, startCommand: 'node server.js' })
  })

  test('keeps the defaults for flags that are not given', async () => {
    await cli('project:create', 'shop')
    await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main')
    const { instance } = await instanceOf('shop', 'web')
    expect(instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(instance.deploy).toMatchObject({ port: 8080, memoryLimitMB: 512 })
    expect(instance.deploy.healthcheckPath).toBeUndefined()
    expect(instance.deploy.startCommand).toBeUndefined()
  })

  test('an unknown project returns exit 1 and queues nothing', async () => {
    expect(await cli('service:create', 'nope', 'web', '--repo', 'acme/web', '--branch', 'main')).toBe(1)
    expect(out).toEqual(['error: project "nope" not found'])
  })

  test('an invalid service name returns exit 1', async () => {
    await cli('project:create', 'shop')
    out.length = 0
    expect(await cli('service:create', 'shop', 'Web App', '--repo', 'acme/web', '--branch', 'main')).toBe(1)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^error: invalid service name/)
  })

  test.each([
    ['--repo', ['--branch', 'main']],
    ['--branch', ['--repo', 'acme/web']],
  ])('requires %s', async (flag, rest) => {
    await cli('project:create', 'shop')
    out.length = 0
    expect(await cli('service:create', 'shop', 'web', ...rest)).toBe(1)
    expect(out[0]).toBe(`error: ${flag} is required`)
    expect(await findServiceInstance(db, 'shop', 'web')).toBeNull()
  })

  test.each(['--memory', '--port'])('rejects a %s that is not a positive integer', async (flag) => {
    await cli('project:create', 'shop')
    for (const value of ['abc', '0', '1.5', '256mb', '', '1e3']) {
      out.length = 0
      expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', `${flag}=${value}`)).toBe(1)
      expect(out[0], `${flag}=${value}`).toBe(`error: ${flag} must be a positive integer`)
    }
    out.length = 0
    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', flag, '-5')).toBe(1)
    expect(out[0]).toMatch(/^error: /)
    expect(await findServiceInstance(db, 'shop', 'web')).toBeNull()
  })

  test('rejects a port above 65535', async () => {
    await cli('project:create', 'shop')
    out.length = 0
    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--port', '65536')).toBe(1)
    expect(out[0]).toBe('error: --port must be at most 65535')
    expect(await findServiceInstance(db, 'shop', 'web')).toBeNull()
  })

  test('rejects a memory limit above the per-service max, accepts exactly the max', async () => {
    await cli('project:create', 'shop')
    const max = deps.config.maxServiceMemoryMb
    out.length = 0
    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', String(max + 1))).toBe(1)
    expect(out).toEqual([`error: --memory exceeds the per-service max of ${max} MB`])
    expect(await findServiceInstance(db, 'shop', 'web')).toBeNull()

    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', String(max))).toBe(0)
    expect((await instanceOf('shop', 'web')).instance.deploy.memoryLimitMB).toBe(max)
  })
})

describe('deploy', () => {
  test('enqueues a manual deployment and prints its id', async () => {
    await addProjectWithService()
    expect(await cli('deploy', 'shop', 'web')).toBe(0)
    const [queued] = await deploymentsOf('shop', 'web')
    expect(queued).toMatchObject({ status: 'QUEUED', trigger: 'manual' })
    expect(out).toEqual([`queued deployment ${queued!.id}`])
  })

  test('an unknown service returns exit 1', async () => {
    await addProjectWithService()
    expect(await cli('deploy', 'shop', 'api')).toBe(1)
    expect(out).toEqual(['error: service shop/api not found'])
  })

  test('an unknown project returns exit 1', async () => {
    expect(await cli('deploy', 'nope', 'web')).toBe(1)
    expect(out).toEqual(['error: service nope/web not found'])
  })
})

describe('rollback', () => {
  test('enqueues a rollback deployment of the given one and prints its id', async () => {
    const instance = await addProjectWithService()
    const target = await succeeded(instance.id, 'vpsm-web-aaaa0000')
    await succeeded(instance.id, 'vpsm-web-bbbb0000')

    expect(await cli('rollback', 'shop', 'web', target.id)).toBe(0)

    const [queued] = await deploymentsOf('shop', 'web')
    expect(queued).toMatchObject({ status: 'QUEUED', trigger: 'rollback', rollbackOfId: target.id })
    expect(out).toEqual([`queued deployment ${queued!.id}`])
  })

  test('refuses a deployment from another service', async () => {
    const instance = await addProjectWithService()
    const other = await addService('shop', 'api')
    const foreign = await succeeded(other.id, 'vpsm-api-aaaa0000')
    await succeeded(instance.id, 'vpsm-web-aaaa0000')

    expect(await cli('rollback', 'shop', 'web', foreign.id)).toBe(1)

    expect(out).toEqual(['error: deployment does not belong to shop/web'])
    expect((await deploymentsOf('shop', 'web')).filter((d) => d.trigger === 'rollback')).toEqual([])
  })

  test('refuses an id that does not exist or is not a uuid', async () => {
    await addProjectWithService()
    for (const id of [randomUUID(), 'not-a-uuid']) {
      out.length = 0
      expect(await cli('rollback', 'shop', 'web', id)).toBe(1)
      expect(out).toEqual(['error: deployment does not belong to shop/web'])
    }
  })

  test('refuses a deployment that has no image', async () => {
    const instance = await addProjectWithService()
    const noImage = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })

    expect(await cli('rollback', 'shop', 'web', noImage.id)).toBe(1)

    expect(out).toEqual([`error: deployment ${noImage.id} has no image to roll back to`])
  })

  test('an unknown service returns exit 1', async () => {
    expect(await cli('rollback', 'shop', 'web', randomUUID())).toBe(1)
    expect(out).toEqual(['error: service shop/web not found'])
  })
})

describe('restart', () => {
  test('restarts the container of the SUCCESS deployment', async () => {
    const instance = await addProjectWithService()
    const live = await succeeded(instance.id, 'vpsm-web-live0000')
    deps.docker.seedRunning([{ name: 'vpsm-web-live0000', memoryMb: 512, deploymentId: live.id, serviceInstanceId: instance.id }])
    await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })

    expect(await cli('restart', 'shop', 'web')).toBe(0)

    expect(deps.events).toEqual(['restart vpsm-web-live0000'])
    expect(out).toEqual(['restarted shop/web'])
  })

  test('uses the newest SUCCESS deployment', async () => {
    const instance = await addProjectWithService()
    await succeeded(instance.id, 'vpsm-web-old00000')
    await succeeded(instance.id, 'vpsm-web-new00000')
    deps.docker.seedRunning([{ name: 'vpsm-web-new00000', memoryMb: 512 }])

    expect(await cli('restart', 'shop', 'web')).toBe(0)

    expect(deps.events).toEqual(['restart vpsm-web-new00000'])
  })

  test('returns exit 1 when nothing is running', async () => {
    const instance = await addProjectWithService()
    await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })

    expect(await cli('restart', 'shop', 'web')).toBe(1)

    expect(out).toEqual(['error: shop/web has no running deployment'])
    expect(deps.events).toEqual([])
  })

  test('an unknown service returns exit 1', async () => {
    expect(await cli('restart', 'shop', 'web')).toBe(1)
    expect(out).toEqual(['error: service shop/web not found'])
  })

  test('reports a failing restart as an error', async () => {
    const instance = await addProjectWithService()
    await succeeded(instance.id, 'vpsm-web-gone0000')

    expect(await cli('restart', 'shop', 'web')).toBe(1)

    expect(out).toEqual(['error: no container vpsm-web-gone0000'])
  })
})

describe('status', () => {
  test('lists services with latest status and URL', async () => {
    const web = await addProjectWithService()
    const api = await addService('shop', 'api')
    await succeeded(web.id, 'vpsm-web-live0000')
    await enqueueDeployment(db, { serviceInstanceId: api.id, trigger: 'manual' })

    expect(await cli('status', 'shop')).toBe(0)

    expect(out).toEqual([
      'api  QUEUED  https://api-shop.apps.example.com',
      'web  SUCCESS  https://web-shop.apps.example.com',
    ])
  })

  test('shows the newest deployment by creation time, not the one that is live', async () => {
    const web = await addProjectWithService()
    await succeeded(web.id, 'vpsm-web-live0000')
    const next = await enqueueDeployment(db, { serviceInstanceId: web.id, trigger: 'manual' })
    await setDeploymentStatus(db, next.id, 'BUILDING')
    await setDeploymentStatus(db, next.id, 'FAILED', { failureReason: 'build failed' })

    await cli('status', 'shop')

    expect(out).toEqual(['web  FAILED  https://web-shop.apps.example.com'])
  })

  test('shows - for a service without deployments', async () => {
    await addProjectWithService()
    await cli('status', 'shop')
    expect(out).toEqual(['web  -  https://web-shop.apps.example.com'])
  })

  test('shows - when the service has no generated domain', async () => {
    const web = await addProjectWithService()
    await succeeded(web.id, 'vpsm-web-live0000')
    const { domains: instanceDomains } = await instanceOf('shop', 'web')
    await db.delete(domains).where(eq(domains.id, instanceDomains[0]!.id))

    await cli('status', 'shop')

    expect(out).toEqual(['web  SUCCESS  -'])
  })

  test('only lists the services of the given project', async () => {
    await addProjectWithService('shop', 'web')
    await addProjectWithService('blog', 'site')
    await cli('status', 'blog')
    expect(out).toEqual(['site  -  https://site-blog.apps.example.com'])
  })

  test('an unknown project returns exit 1', async () => {
    expect(await cli('status', 'nope')).toBe(1)
    expect(out).toEqual(['error: project nope not found'])
  })
})

describe('logs', () => {
  test('prints the lines of a deployment in order, only its own', async () => {
    const instance = await addProjectWithService()
    const first = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })
    const second = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })
    await appendDeploymentLogs(db, first.id, 'build', ['one', 'two'])
    await appendDeploymentLogs(db, second.id, 'build', ['other'])
    await appendDeploymentLogs(db, first.id, 'deploy', ['three'])

    expect(await cli('logs', first.id)).toBe(0)

    expect(out).toEqual(['one', 'two', 'three'])
  })

  test('prints nothing for a deployment without logs', async () => {
    const instance = await addProjectWithService()
    const queued = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })
    expect(await cli('logs', queued.id)).toBe(0)
    expect(out).toEqual([])
  })

  test('an unknown deployment returns exit 1', async () => {
    const id = randomUUID()
    expect(await cli('logs', id)).toBe(1)
    expect(out).toEqual([`error: deployment ${id} not found`])
  })

  test('an id that is not a uuid is reported as not found', async () => {
    expect(await cli('logs', 'abc')).toBe(1)
    expect(out).toEqual(['error: deployment abc not found'])
  })
})

describe('usage', () => {
  test('no command prints the usage and returns 1', async () => {
    expect(await cli()).toBe(1)
    expect(out[0]).toMatch(/^error: /)
    expect(usageLines().join('\n')).toContain('service:create <project> <service> --repo <owner/name> --branch <branch>')
  })

  test('an unknown command prints an error and the usage', async () => {
    expect(await cli('frobnicate', 'shop')).toBe(1)
    expect(out[0]).toBe('error: unknown command "frobnicate"')
    expect(usageLines().join('\n')).toContain('status <project>')
  })

  test('--help prints the usage and returns 0', async () => {
    expect(await cli('--help')).toBe(0)
    expect(out.some((line) => line.startsWith('error'))).toBe(false)
    expect(usageLines().join('\n')).toContain('rollback <project> <service> <deploymentId>')
  })

  test('--help after a command also prints the usage and returns 0', async () => {
    expect(await cli('deploy', '--help')).toBe(0)
    expect(usageLines().length).toBeGreaterThan(0)
  })

  test.each([
    [['project:create'], 'project:create <project>'],
    [['service:create', 'shop'], 'service:create <project> <service>'],
    [['deploy', 'shop'], 'deploy <project> <service>'],
    [['rollback', 'shop', 'web'], 'rollback <project> <service> <deploymentId>'],
    [['restart', 'shop'], 'restart <project> <service>'],
    [['status'], 'status <project>'],
    [['logs'], 'logs <deploymentId>'],
  ])('%j with a missing argument returns 1 with the usage', async (argv, usage) => {
    expect(await cli(...argv)).toBe(1)
    expect(out[0]).toMatch(/^error: /)
    expect(usageLines().join('\n')).toContain(usage)
  })

  test('an extra argument returns 1', async () => {
    expect(await cli('status', 'shop', 'web')).toBe(1)
    expect(out[0]).toMatch(/^error: /)
  })

  test('an unknown flag returns 1 with an error line', async () => {
    expect(await cli('deploy', 'shop', 'web', '--force')).toBe(1)
    expect(out[0]).toMatch(/^error: /)
  })
})
