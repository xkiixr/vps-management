import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { asc, desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appendDeploymentLogs,
  auditEvents,
  authenticate,
  createAppService,
  createProject,
  createSession,
  createUser,
  type Deployment,
  deployments,
  domains,
  enqueueDeployment,
  findServiceInstance,
  markDeploymentLive,
  projects,
  resolveSession,
  setDeploymentStatus,
  setResourceSettings,
  setUserDisabled,
  users,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { runCli } from '../src/cli'
import { fakeDeps, type FakeDeps } from './fakes'

// Set to make recordAudit fail, like a database that stops accepting writes.
const auditFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))

vi.mock('@vpsm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vpsm/db')>()
  return {
    ...actual,
    recordAudit: async (...args: Parameters<typeof actual.recordAudit>) => {
      if (auditFailure.error) throw auditFailure.error
      return actual.recordAudit(...args)
    },
  }
})

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let out: string[]

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  auditFailure.error = undefined
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

  test('prints the URL with the public HTTPS port when it is not 443', async () => {
    deps.config = { ...deps.config, publicHttpsPort: 8443 }
    await createProject(db, 'shop')
    await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main')
    const [queued] = await deploymentsOf('shop', 'web')
    expect(out).toEqual(['https://web-shop.apps.example.com:8443', `queued deployment ${queued!.id}`])
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

  test('the per-service max from the settings applies before the one from the environment', async () => {
    await cli('project:create', 'shop')
    const [admin] = await db
      .insert(users)
      .values({ email: 'root@example.com', name: 'root', role: 'admin', passwordHash: 'x' })
      .returning({ id: users.id })
    const service = (name: string, memory: number) =>
      cli('service:create', 'shop', name, '--repo', 'acme/web', '--branch', 'main', '--memory', String(memory))

    // The environment allows 2048 MB; the settings allow more.
    await setResourceSettings(db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 4096 }, admin!.id)
    out.length = 0
    expect(await service('big', 3000)).toBe(0)
    expect((await instanceOf('shop', 'big')).instance.deploy.memoryLimitMB).toBe(3000)

    // ...or less.
    await setResourceSettings(db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 1024 }, admin!.id)
    out.length = 0
    expect(await service('over', 1025)).toBe(1)
    expect(out).toEqual(['error: --memory exceeds the per-service max of 1024 MB'])
    expect(await findServiceInstance(db, 'shop', 'over')).toBeNull()
    expect(await service('exact', 1024)).toBe(0)
  })

  test('rejects a memory limit below the 6 MB Docker accepts, accepts exactly 6', async () => {
    await cli('project:create', 'shop')
    for (const memory of ['1', '5']) {
      out.length = 0
      expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', memory)).toBe(1)
      expect(out, `--memory ${memory}`).toEqual(['error: --memory must be at least 6'])
    }
    expect(await findServiceInstance(db, 'shop', 'web')).toBeNull()

    expect(await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', '6')).toBe(0)
    expect((await instanceOf('shop', 'web')).instance.deploy.memoryLimitMB).toBe(6)
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

  test('shows URLs with the public HTTPS port when it is not 443', async () => {
    deps.config = { ...deps.config, publicHttpsPort: 8443 }
    await addProjectWithService()
    await cli('status', 'shop')
    expect(out).toEqual(['web  -  https://web-shop.apps.example.com:8443'])
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

const PASSWORD_LINE = /^password: [A-Za-z0-9]{20}$/
const passwordOf = (line: string | undefined) => line!.slice('password: '.length)

async function addUser(email: string, role: 'admin' | 'member' = 'member', password = 'old-password-123') {
  return createUser(db, { email, name: email.split('@')[0]!, role, password })
}

describe('user:create', () => {
  test('creates the user and prints a generated password once', async () => {
    expect(await cli('user:create', 'ann@example.com', '--name', 'Ann')).toBe(0)

    expect(out).toHaveLength(2)
    expect(out[0]).toBe('created user ann@example.com (member)')
    expect(out[1]).toMatch(PASSWORD_LINE)
    expect(await authenticate(db, 'ann@example.com', passwordOf(out[1]))).toMatchObject({
      email: 'ann@example.com',
      name: 'Ann',
      role: 'member',
      disabledAt: null,
    })
  })

  test('--admin creates an admin', async () => {
    expect(await cli('user:create', 'root@example.com', '--name', 'Root', '--admin')).toBe(0)

    expect(out[0]).toBe('created user root@example.com (admin)')
    expect(await authenticate(db, 'root@example.com', passwordOf(out[1]))).toMatchObject({ role: 'admin' })
  })

  test('every user gets a password of its own', async () => {
    await cli('user:create', 'ann@example.com', '--name', 'Ann')
    const first = out[1]
    out.length = 0
    await cli('user:create', 'bob@example.com', '--name', 'Bob')
    expect(out[1]).toMatch(PASSWORD_LINE)
    expect(out[1]).not.toBe(first)
  })

  test('the email is stored in lowercase and printed that way', async () => {
    expect(await cli('user:create', ' Ann@Example.COM ', '--name', 'Ann')).toBe(0)
    expect(out[0]).toBe('created user ann@example.com (member)')
  })

  test('requires --name', async () => {
    expect(await cli('user:create', 'ann@example.com')).toBe(1)

    expect(out[0]).toBe('error: --name is required')
    expect(usageLines().join('\n')).toContain('user:create <email> --name <name> [--admin]')
    expect(await db.select().from(users)).toEqual([])
  })

  test('a duplicate email returns exit 1 without printing a password', async () => {
    await addUser('ann@example.com')

    expect(await cli('user:create', 'ann@example.com', '--name', 'Ann')).toBe(1)

    expect(out).toEqual(['error: a user with this email already exists'])
    expect(await db.select().from(auditEvents)).toEqual([])
  })

  test('an invalid email returns exit 1 without printing a password', async () => {
    expect(await cli('user:create', 'not-an-email', '--name', 'Ann')).toBe(1)

    expect(out).toEqual(['error: invalid email address "not-an-email"'])
    expect(await db.select().from(users)).toEqual([])
  })

  test('records an audit event from the cli that holds no password', async () => {
    await cli('user:create', 'ann@example.com', '--name', 'Ann')
    const [created] = await db.select().from(users)

    const events = await db.select().from(auditEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorId: null,
      action: 'user.create',
      targetType: 'user',
      targetId: created!.id,
      metadata: { via: 'cli', email: 'ann@example.com', role: 'member' },
    })
    expect(JSON.stringify(events)).not.toContain(passwordOf(out[1]))
  })

  test('the password is not shown again by user:list', async () => {
    await cli('user:create', 'ann@example.com', '--name', 'Ann')
    const password = passwordOf(out[1])
    out.length = 0

    await cli('user:list')

    expect(out).toEqual(['ann@example.com  member  active'])
    expect(out.join('\n')).not.toContain(password)
  })
})

describe('user:reset-password', () => {
  test('sets a new generated password and prints it', async () => {
    await addUser('ann@example.com')

    expect(await cli('user:reset-password', 'ann@example.com')).toBe(0)

    expect(out).toHaveLength(2)
    expect(out[0]).toBe('reset password for ann@example.com')
    expect(out[1]).toMatch(PASSWORD_LINE)
    expect(await authenticate(db, 'ann@example.com', 'old-password-123')).toBeNull()
    expect(await authenticate(db, 'ann@example.com', passwordOf(out[1]))).toMatchObject({ email: 'ann@example.com' })
  })

  test('ends the sessions of the user', async () => {
    const ann = await addUser('ann@example.com')
    const { token } = await createSession(db, ann.id)

    await cli('user:reset-password', 'ann@example.com')

    expect(await resolveSession(db, token)).toBeNull()
  })

  test('finds the user whatever the case of the email', async () => {
    await addUser('ann@example.com')
    expect(await cli('user:reset-password', 'ANN@Example.com')).toBe(0)
    expect(out[0]).toBe('reset password for ann@example.com')
  })

  test('an unknown email returns exit 1 and records nothing', async () => {
    expect(await cli('user:reset-password', 'nobody@example.com')).toBe(1)

    expect(out).toEqual(['error: user nobody@example.com not found'])
    expect(await db.select().from(auditEvents)).toEqual([])
  })

  test('records an audit event from the cli that holds no password', async () => {
    const ann = await addUser('ann@example.com')

    await cli('user:reset-password', 'ann@example.com')

    const events = await db.select().from(auditEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorId: null,
      action: 'user.reset_password',
      targetType: 'user',
      targetId: ann.id,
      metadata: { via: 'cli', email: 'ann@example.com' },
    })
    expect(JSON.stringify(events)).not.toContain(passwordOf(out[1]))
  })
})

describe('user:list', () => {
  test('prints nothing when there are no users', async () => {
    expect(await cli('user:list')).toBe(0)
    expect(out).toEqual([])
  })

  test('lists email, role and state, ordered by email', async () => {
    await addUser('bob@example.com', 'admin')
    const ann = await addUser('ann@example.com')
    await addUser('cy@example.com')
    await setUserDisabled(db, ann.id, true)

    expect(await cli('user:list')).toBe(0)

    expect(out).toEqual([
      'ann@example.com  member  disabled',
      'bob@example.com  admin  active',
      'cy@example.com  member  active',
    ])
  })

  test('never prints a password hash, and records nothing', async () => {
    await addUser('ann@example.com')
    await cli('user:list')

    expect(out.join('\n')).not.toMatch(/argon2|\$/)
    expect(await db.select().from(auditEvents)).toEqual([])
  })
})

describe('audit', () => {
  const events = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id))

  test('project:create', async () => {
    await cli('project:create', 'shop')
    const [project] = await db.select().from(projects)

    expect(await events()).toMatchObject([
      { actorId: null, action: 'project.create', targetType: 'project', targetId: project!.id, metadata: { via: 'cli', name: 'shop' } },
    ])
  })

  test('service:create', async () => {
    await cli('project:create', 'shop')
    await cli('service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main')
    const { service } = await instanceOf('shop', 'web')

    const [, event, ...rest] = await events()
    expect(rest).toEqual([])
    expect(event).toMatchObject({
      actorId: null,
      action: 'service.create',
      targetType: 'service',
      targetId: service.id,
      metadata: { via: 'cli', project: 'shop', service: 'web' },
    })
  })

  test('deploy', async () => {
    await addProjectWithService()
    await cli('deploy', 'shop', 'web')
    const [queued] = await deploymentsOf('shop', 'web')

    expect(await events()).toMatchObject([
      {
        actorId: null,
        action: 'deployment.deploy',
        targetType: 'deployment',
        targetId: queued!.id,
        metadata: { via: 'cli', project: 'shop', service: 'web' },
      },
    ])
  })

  test('rollback', async () => {
    const instance = await addProjectWithService()
    const target = await succeeded(instance.id, 'vpsm-web-aaaa0000')
    await succeeded(instance.id, 'vpsm-web-bbbb0000')
    await cli('rollback', 'shop', 'web', target.id)
    const [queued] = await deploymentsOf('shop', 'web')

    expect(await events()).toMatchObject([
      {
        actorId: null,
        action: 'deployment.rollback',
        targetType: 'deployment',
        targetId: queued!.id,
        metadata: { via: 'cli', project: 'shop', service: 'web', rollbackOfId: target.id },
      },
    ])
  })

  test('restart', async () => {
    const instance = await addProjectWithService()
    const live = await succeeded(instance.id, 'vpsm-web-live0000')
    deps.docker.seedRunning([{ name: 'vpsm-web-live0000', memoryMb: 512 }])

    await cli('restart', 'shop', 'web')

    expect(await events()).toMatchObject([
      {
        actorId: null,
        action: 'container.restart',
        targetType: 'container',
        targetId: 'vpsm-web-live0000',
        metadata: { via: 'cli', project: 'shop', service: 'web', deploymentId: live.id },
      },
    ])
  })

  test('a command that fails records nothing', async () => {
    await addProjectWithService()
    await cli('project:create', 'shop')
    await cli('deploy', 'shop', 'nope')
    await cli('rollback', 'shop', 'web', randomUUID())
    await cli('restart', 'shop', 'web')
    await cli('service:create', 'shop', 'web')

    expect(await events()).toEqual([])
  })

  test('commands that only read record nothing', async () => {
    const instance = await addProjectWithService()
    const queued = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })
    await cli('status', 'shop')
    await cli('logs', queued.id)
    await cli('user:list')

    expect(await events()).toEqual([])
  })

  describe('when it cannot be recorded', () => {
    let warnings: string[]
    let spy: { mockRestore(): void }
    beforeEach(() => {
      auditFailure.error = new Error('audit database is down')
      warnings = []
      spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')))
    })
    afterEach(() => spy.mockRestore())

    test('the command still succeeds and only a short warning goes to stderr', async () => {
      expect(await cli('project:create', 'shop')).toBe(0)

      expect(out).toEqual(['created project shop'])
      expect(warnings).toEqual(['warning: could not record the audit event: audit database is down'])
      expect(await db.select().from(projects)).toHaveLength(1)
    })

    test('a deployment is still queued', async () => {
      await addProjectWithService()

      expect(await cli('deploy', 'shop', 'web')).toBe(0)

      expect((await deploymentsOf('shop', 'web'))[0]).toMatchObject({ status: 'QUEUED' })
      expect(out).toHaveLength(1)
      expect(warnings).toHaveLength(1)
    })

    test('a created user keeps the password on stdout', async () => {
      expect(await cli('user:create', 'ann@example.com', '--name', 'Ann')).toBe(0)

      expect(out[1]).toMatch(PASSWORD_LINE)
      expect(await authenticate(db, 'ann@example.com', passwordOf(out[1]))).not.toBeNull()
      expect(warnings.join('\n')).not.toContain(passwordOf(out[1]))
    })
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
    [['user:create'], 'user:create <email> --name <name> [--admin]'],
    [['user:reset-password'], 'user:reset-password <email>'],
    [['user:list', 'extra'], 'user:list'],
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
