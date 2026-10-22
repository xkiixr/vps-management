import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  createUser,
  enqueueDeployment,
  findService,
  setDeploymentStatus,
  setResourceSettings,
  type Actor,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { NotFoundError } from '@/server/errors'
import { doCreateService, doDeleteService, doSaveServiceSettings } from '@/server/services'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const SITE = { appsDomain: 'apps.example.com', httpsPort: 443 }

let ada: SafeUser
let bob: SafeUser
let root: SafeUser
const actorOf = (user: SafeUser): Actor => ({ id: user.id, role: user.role })

beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  ada = await make('ada@example.com', 'Ada', 'member')
  bob = await make('bob@example.com', 'Bob', 'member')
  root = await make('root@example.com', 'Root', 'admin')
  // The CLI default must not leak in from the machine running the tests.
  vi.stubEnv('MAX_SERVICE_MEMORY_MB', '')
})

const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`
const serviceNames = async () => (await t.sql`select name from services order by name`).map((row) => row.name)
const deploymentRows = () => t.sql`select trigger, status, created_by_id, service_instance_id from deployments order by created_at, id`

// Ada's project `shop`, and optionally a service in it, the way Plan 1's CLI makes one.
async function adasProject(name = 'shop') {
  return createProject(t.db, name, ada.id)
}
async function addService(projectName = 'shop', serviceName = 'web') {
  const created = await createAppService(t.db, {
    projectName,
    serviceName,
    source: { repo: 'acme/web', branch: 'main' },
    deploy: { port: 8080, memoryLimitMB: 512 },
    appsDomain: SITE.appsDomain,
  })
  return created
}
async function current(projectName = 'shop', serviceName = 'web') {
  const [project] = await t.sql`select id from projects where name = ${projectName}`
  return (await findService(t.db, project!.id, serviceName, { httpsPort: 443 }))!
}

const VALID = { name: 'web', repo: 'acme/web' }
const NAME_MUST_BE = expect.stringContaining('name must be')

describe('doCreateService', () => {
  test('creates the service with the defaults, queues a manual deployment by the actor and records service.create', async () => {
    await adasProject()
    const result = await doCreateService(t.db, actorOf(ada), 'shop', VALID, SITE)
    if (!('service' in result)) throw new Error(`expected a service, got ${JSON.stringify(result)}`)
    expect(result.service).toMatchObject({ name: 'web', projectName: 'shop' })

    const row = await current()
    expect(row.service.id).toBe(result.service.id)
    expect(row.instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(row.instance.deploy).toMatchObject({ port: 8080, memoryLimitMB: 512 })
    expect(row.instance.deploy).not.toHaveProperty('healthcheckPath')
    expect(row.instance.deploy).not.toHaveProperty('startCommand')
    expect(row.url).toBe('https://web-shop.apps.example.com')

    expect(await deploymentRows()).toEqual([
      { trigger: 'manual', status: 'QUEUED', created_by_id: ada.id, service_instance_id: row.instance.id },
    ])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'service.create',
        target_type: 'service',
        target_id: row.service.id,
        metadata: { project: 'shop', service: 'web', repo: 'acme/web' },
      },
    ])
  })

  test('takes every field, trims them, and treats blank optional fields as not given', async () => {
    await adasProject()
    const result = await doCreateService(
      t.db,
      actorOf(ada),
      'shop',
      {
        name: '  api ',
        repo: ' acme/api ',
        branch: ' release ',
        rootDirectory: ' services/api ',
        healthcheckPath: ' /healthz ',
        port: ' 3000 ',
        memoryLimitMB: ' 256 ',
        startCommand: ' node server.js ',
      },
      SITE,
    )
    expect(result).toHaveProperty('service')
    const row = await current('shop', 'api')
    expect(row.instance.source).toEqual({ repo: 'acme/api', branch: 'release', rootDirectory: 'services/api' })
    expect(row.instance.deploy).toMatchObject({
      healthcheckPath: '/healthz',
      port: 3000,
      memoryLimitMB: 256,
      startCommand: 'node server.js',
    })

    await doCreateService(
      t.db,
      actorOf(ada),
      'shop',
      { name: 'worker', repo: 'acme/w', branch: '  ', rootDirectory: '  ', healthcheckPath: '', port: '', memoryLimitMB: ' ', startCommand: '   ' },
      SITE,
    )
    const blank = await current('shop', 'worker')
    expect(blank.instance.source).toEqual({ repo: 'acme/w', branch: 'main' })
    expect(blank.instance.deploy).toMatchObject({ port: 8080, memoryLimitMB: 512 })
    expect(blank.instance.deploy).not.toHaveProperty('healthcheckPath')
    expect(blank.instance.deploy).not.toHaveProperty('startCommand')
  })

  test.each([
    ['a name in capitals', { name: 'Web' }, 'name', NAME_MUST_BE],
    ['no name', { name: '' }, 'name', 'name is required'],
    ['a name that is a path', { name: '../x' }, 'name', NAME_MUST_BE],
    ['a name of 31 characters', { name: 'a'.repeat(31) }, 'name', NAME_MUST_BE],
    ['a repo with a space', { repo: 'acme web' }, 'repo', 'use the form owner/name'],
    ['a repo without an owner', { repo: 'web' }, 'repo', 'use the form owner/name'],
    ['no repo', { repo: '' }, 'repo', 'use the form owner/name'],
    ['a branch with a space', { branch: 'my branch' }, 'branch', 'invalid branch name'],
    ['a branch that looks like an option', { branch: '-x' }, 'branch', 'invalid branch name'],
    ['a rootDirectory that leaves the repository', { rootDirectory: '../etc' }, 'rootDirectory', 'must stay inside the repository'],
    ['a healthcheck path without a slash', { healthcheckPath: 'health' }, 'healthcheckPath', 'must start with /'],
    ['a healthcheck path with a space', { healthcheckPath: '/a b' }, 'healthcheckPath', 'must not contain spaces'],
    ['port 0', { port: '0' }, 'port', 'must be between 1 and 65535'],
    ['port 70000', { port: '70000' }, 'port', 'must be between 1 and 65535'],
    ['a port with 400 digits', { port: '9'.repeat(400) }, 'port', 'must be between 1 and 65535'],
    ['memory 0', { memoryLimitMB: '0' }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
    ['memory 5', { memoryLimitMB: '5' }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
    ['memory over the maximum', { memoryLimitMB: '2049' }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
    ['a start command of 1001 characters', { startCommand: 'x'.repeat(1001) }, 'startCommand', 'must be at most 1000 characters'],
  ])('%s is a field error and creates and queues nothing', async (_what, patch, field, message) => {
    await adasProject()
    const result = await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, ...patch }, SITE)
    expect(result).toEqual({ fieldErrors: { [field]: message } })
    expect(await serviceNames()).toEqual([])
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test.each([['port'], ['memoryLimitMB']] as const)(
    '%s must be digits only: signs, fractions, exponents, other scripts and units are not numbers',
    async (field) => {
      await adasProject()
      for (const value of ['abc', '80.5', '-1', '+80', '1e3', '0x10', '1,000', '８０', '٨٠', '12MB', '8 0']) {
        const result = await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, [field]: value }, SITE)
        expect(result, value).toEqual({ fieldErrors: { [field]: 'must be a whole number' } })
      }
      expect(await serviceNames()).toEqual([])
      expect(await deploymentRows()).toEqual([])
    },
  )

  test('leading zeros are still a whole number', async () => {
    await adasProject()
    expect(await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, port: '0080', memoryLimitMB: '0256' }, SITE)).toHaveProperty('service')
    expect((await current()).instance.deploy).toMatchObject({ port: 80, memoryLimitMB: 256 })
  })

  test.each([
    ['name', 'we\u0000b'],
    ['name', 'we\nb'],
    ['repo', 'acme/we\u0000b'],
    ['repo', 'acme/we\tb'],
    ['branch', 'ma\u0000in'],
    ['branch', 'ma\u007fin'],
    ['rootDirectory', 'a\u0000b'],
    ['rootDirectory', 'a\nb'],
    ['healthcheckPath', '/a\u0000b'],
    ['healthcheckPath', '/a\u0001b'],
    ['startCommand', 'node a.js\nrm -rf /'],
    ['startCommand', 'node\u0000a.js'],
    ['port', '8\u00000'],
    ['memoryLimitMB', '5\n12'],
  ])('a control character in %s (%j) is "contains invalid characters" and creates nothing', async (field, value) => {
    await adasProject()
    const result = await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, [field]: value }, SITE)
    expect(result).toEqual({ fieldErrors: { [field]: 'contains invalid characters' } })
    expect(await serviceNames()).toEqual([])
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('every wrong field is reported at once', async () => {
    await adasProject()
    const result = await doCreateService(
      t.db,
      actorOf(ada),
      'shop',
      {
        name: 'Bad Name',
        repo: 'nope',
        branch: 'a b',
        rootDirectory: '../x',
        healthcheckPath: 'x',
        port: 'abc',
        memoryLimitMB: '0',
        startCommand: 'a\nb',
      },
      SITE,
    )
    expect(result).toEqual({
      fieldErrors: {
        name: expect.stringContaining('name must be'),
        repo: 'use the form owner/name',
        branch: 'invalid branch name',
        rootDirectory: 'must stay inside the repository',
        healthcheckPath: 'must start with /',
        port: 'must be a whole number',
        memoryLimitMB: 'must be between 6 and 2048 MB',
        startCommand: 'contains invalid characters',
      },
    })
    expect(await serviceNames()).toEqual([])
  })

  test('nothing at all is a name and a repo missing', async () => {
    await adasProject()
    expect(await doCreateService(t.db, actorOf(ada), 'shop', {}, SITE)).toEqual({
      fieldErrors: { name: 'name is required', repo: 'use the form owner/name' },
    })
    expect(await serviceNames()).toEqual([])
  })

  test('the largest memory is the one the admin saved, else MAX_SERVICE_MEMORY_MB, else 2048', async () => {
    await adasProject()
    vi.stubEnv('MAX_SERVICE_MEMORY_MB', '1024')
    expect(await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, memoryLimitMB: '2048' }, SITE)).toEqual({
      fieldErrors: { memoryLimitMB: 'must be between 6 and 1024 MB' },
    })
    await setResourceSettings(t.db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 4096 }, root.id)
    expect(await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, memoryLimitMB: '4096' }, SITE)).toHaveProperty('service')
    expect(await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, name: 'two', memoryLimitMB: '4097' }, SITE)).toEqual({
      fieldErrors: { memoryLimitMB: 'must be between 6 and 4096 MB' },
    })
  })

  test('a name already used in the project is a name error and queues nothing more', async () => {
    await adasProject()
    await doCreateService(t.db, actorOf(ada), 'shop', VALID, SITE)
    await t.sql`delete from audit_events`
    const result = await doCreateService(t.db, actorOf(ada), 'shop', VALID, SITE)
    expect(result).toEqual({ fieldErrors: { name: 'service "web" already exists in project "shop"' } })
    expect(await serviceNames()).toEqual(['web'])
    expect(await deploymentRows()).toHaveLength(1)
    expect(await auditRows()).toEqual([])
  })

  test('a generated hostname already taken by another service is a name error too', async () => {
    // web-app + shop → "web-app-shop", and so does web + app-shop.
    await createProject(t.db, 'app-shop', ada.id)
    await adasProject('shop')
    expect(await doCreateService(t.db, actorOf(ada), 'app-shop', VALID, SITE)).toHaveProperty('service')
    const result = await doCreateService(t.db, actorOf(ada), 'shop', { ...VALID, name: 'web-app' }, SITE)
    expect(result).toEqual({
      fieldErrors: { name: 'hostname web-app-shop.apps.example.com is already used by another service' },
    })
    expect(await serviceNames()).toEqual(['web'])
    expect(await deploymentRows()).toHaveLength(1)
  })

  test('an outsider gets NotFound whatever they send, and nothing is created', async () => {
    await adasProject()
    for (const input of [VALID, {}, { name: 'Bad Name' }]) {
      await expect(doCreateService(t.db, actorOf(bob), 'shop', input, SITE)).rejects.toBeInstanceOf(NotFoundError)
    }
    expect(await serviceNames()).toEqual([])
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('a project that does not exist, or a malformed project name, is NotFound too', async () => {
    await adasProject()
    for (const name of ['nothing', '../x', '']) {
      await expect(doCreateService(t.db, actorOf(ada), name, VALID, SITE)).rejects.toBeInstanceOf(NotFoundError)
    }
    await expect(doCreateService(t.db, actorOf(ada), undefined as unknown as string, VALID, SITE)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('an admin who is not a member can create a service', async () => {
    await adasProject()
    expect(await doCreateService(t.db, actorOf(root), 'shop', VALID, SITE)).toHaveProperty('service')
    expect((await deploymentRows())[0]).toMatchObject({ created_by_id: root.id })
    expect((await auditRows())[0]).toMatchObject({ actor_id: root.id, action: 'service.create' })
  })

  test('an unexpected failure propagates for the generic mapping and nothing is queued', async () => {
    await adasProject()
    await t.sql`alter table domains rename to domains_away`
    try {
      await expect(doCreateService(t.db, actorOf(ada), 'shop', VALID, SITE)).rejects.toThrow()
    } finally {
      await t.sql`alter table domains_away rename to domains`
    }
    expect(await serviceNames()).toEqual([])
    expect(await deploymentRows()).toEqual([])
  })

  test('if only queuing fails, the service that now exists is still reported (and the failure logged)', async () => {
    await adasProject()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table deployments rename to deployments_away`
    let result: Awaited<ReturnType<typeof doCreateService>>
    try {
      result = await doCreateService(t.db, actorOf(ada), 'shop', VALID, SITE)
    } finally {
      await t.sql`alter table deployments_away rename to deployments`
    }
    expect(result).toHaveProperty('service')
    expect(await serviceNames()).toEqual(['web'])
    expect((await auditRows()).map((r) => r.action)).toEqual(['service.create'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('queuing the first deployment')
  })
})

describe('doSaveServiceSettings', () => {
  const SAME = {
    repo: 'acme/web',
    branch: 'main',
    rootDirectory: '',
    healthcheckPath: '',
    port: '8080',
    memoryLimitMB: '512',
    startCommand: '',
  }
  const save = (actor: SafeUser, input: Record<string, string | undefined>, project = 'shop', service = 'web') =>
    doSaveServiceSettings(t.db, actorOf(actor), project, service, input, SITE)

  async function shopWithWeb() {
    await adasProject()
    const { instance } = await addService()
    return instance
  }

  test('save-deploy saves, queues a "config" deployment by the actor and records service.update with the changed field names', async () => {
    const instance = await shopWithWeb()
    const result = await save(ada, { ...SAME, port: '3000', intent: 'save-deploy' })
    expect(result).toEqual({ notice: 'Settings saved. A deployment is queued.' })

    expect((await current()).instance.deploy).toMatchObject({ port: 3000, memoryLimitMB: 512 })
    expect(await deploymentRows()).toEqual([
      { trigger: 'config', status: 'QUEUED', created_by_id: ada.id, service_instance_id: instance.id },
    ])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'service.update',
        target_type: 'service',
        target_id: (await current()).service.id,
        metadata: { project: 'shop', service: 'web', fields: ['port'] },
      },
    ])
  })

  test('without an intent it is save-deploy, and so is any other value', async () => {
    await shopWithWeb()
    await save(ada, { ...SAME, port: '3001' })
    await save(ada, { ...SAME, port: '3002', intent: 'something-else' })
    expect((await deploymentRows()).map((d) => d.trigger)).toEqual(['config', 'config'])
  })

  test('save-only saves and records the event but queues nothing', async () => {
    await shopWithWeb()
    const result = await save(ada, { ...SAME, branch: 'develop', intent: 'save-only' })
    expect(result).toEqual({ notice: 'Settings saved. They go live with the next deploy.' })
    expect((await current()).instance.source).toEqual({ repo: 'acme/web', branch: 'develop' })
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([
      expect.objectContaining({ action: 'service.update', metadata: { project: 'shop', service: 'web', fields: ['branch'] } }),
    ])
  })

  test('the event names the fields that changed, in form order, and never their values', async () => {
    await shopWithWeb()
    await save(ada, {
      repo: 'acme/other-repo',
      branch: 'release-secret-branch',
      rootDirectory: 'packages/hidden-dir',
      healthcheckPath: '/hidden-health',
      port: '4321',
      memoryLimitMB: '321',
      startCommand: 'node run.js --token=SUPERSECRET',
      intent: 'save-only',
    })
    const [event] = await auditRows()
    expect(event!.metadata).toEqual({
      project: 'shop',
      service: 'web',
      fields: ['repo', 'branch', 'rootDirectory', 'healthcheckPath', 'port', 'memoryLimitMB', 'startCommand'],
    })
    const text = JSON.stringify(event)
    for (const secret of ['other-repo', 'secret-branch', 'hidden-dir', 'hidden-health', '4321', '321', 'SUPERSECRET', 'run.js']) {
      expect(text).not.toContain(secret)
    }
  })

  test('a field submitted with the value it already has is not a change', async () => {
    await shopWithWeb()
    await save(ada, { ...SAME, repo: ' acme/web ', port: '08080', branch: 'dev', intent: 'save-only' })
    expect((await auditRows())[0]!.metadata).toEqual({ project: 'shop', service: 'web', fields: ['branch'] })
  })

  test('a blank optional field removes it, and that counts as a change', async () => {
    await shopWithWeb()
    await save(ada, { ...SAME, rootDirectory: 'app', healthcheckPath: '/up', startCommand: 'node a.js', intent: 'save-only' })
    await t.sql`delete from audit_events`
    await save(ada, { ...SAME, intent: 'save-only' })
    const row = await current()
    expect(row.instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(row.instance.deploy).not.toHaveProperty('healthcheckPath')
    expect(row.instance.deploy).not.toHaveProperty('startCommand')
    expect((await auditRows())[0]!.metadata).toEqual({
      project: 'shop',
      service: 'web',
      fields: ['rootDirectory', 'healthcheckPath', 'startCommand'],
    })
  })

  test('a field that is not submitted at all is left as it is', async () => {
    await shopWithWeb()
    await save(ada, { port: '9000', intent: 'save-only' })
    const row = await current()
    expect(row.instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(row.instance.deploy).toMatchObject({ port: 9000, memoryLimitMB: 512 })
  })

  test('save-deploy with nothing changed still deploys (the settings may have been saved earlier), and records nothing', async () => {
    await shopWithWeb()
    expect(await save(ada, { ...SAME, intent: 'save-deploy' })).toEqual({ notice: 'Settings saved. A deployment is queued.' })
    expect((await deploymentRows()).map((d) => d.trigger)).toEqual(['config'])
    expect(await auditRows()).toEqual([])
  })

  test('save-only with nothing changed does nothing at all', async () => {
    await shopWithWeb()
    await save(ada, { ...SAME, intent: 'save-only' })
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test.each([
    ['memory 0', { memoryLimitMB: '0' }, { memoryLimitMB: 'must be between 6 and 2048 MB' }],
    ['memory over the maximum', { memoryLimitMB: '4096' }, { memoryLimitMB: 'must be between 6 and 2048 MB' }],
    ['port 70000', { port: '70000' }, { port: 'must be between 1 and 65535' }],
    ['a healthcheck path without a slash', { healthcheckPath: 'health' }, { healthcheckPath: 'must start with /' }],
    ['a repo with a space', { repo: 'acme web' }, { repo: 'use the form owner/name' }],
    ['no repo', { repo: '' }, { repo: 'use the form owner/name' }],
    ['no branch', { branch: '' }, { branch: 'branch is required' }],
    ['a rootDirectory with ..', { rootDirectory: '../x' }, { rootDirectory: 'must stay inside the repository' }],
    ['a port that is not a number', { port: 'abc' }, { port: 'must be a whole number' }],
    ['a port with a fraction', { port: '80.5' }, { port: 'must be a whole number' }],
    ['no port', { port: '' }, { port: 'must be a whole number' }],
    ['a memory limit with a unit', { memoryLimitMB: '256MB' }, { memoryLimitMB: 'must be a whole number' }],
    ['a control character in the start command', { startCommand: 'a\nb' }, { startCommand: 'contains invalid characters' }],
    ['a control character in the repo', { repo: 'acme/w\u0000' }, { repo: 'contains invalid characters' }],
  ])('%s is a field error: nothing is saved, queued or recorded', async (_what, patch, expected) => {
    await shopWithWeb()
    const before = await current()
    for (const intent of ['save-deploy', 'save-only']) {
      const result = await save(ada, { ...SAME, ...patch, intent })
      expect(result).toEqual({ fieldErrors: expected })
    }
    const after = await current()
    expect(after.instance.source).toEqual(before.instance.source)
    expect(after.instance.deploy).toEqual(before.instance.deploy)
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('all the wrong fields are shown together, and a good field next to them is not saved', async () => {
    await shopWithWeb()
    const result = await save(ada, {
      ...SAME,
      repo: 'acme/ok-repo',
      port: 'abc',
      memoryLimitMB: '0',
      healthcheckPath: 'x',
      branch: 'a b',
      intent: 'save-deploy',
    })
    expect(result).toEqual({
      fieldErrors: {
        port: 'must be a whole number',
        memoryLimitMB: 'must be between 6 and 2048 MB',
        healthcheckPath: 'must start with /',
        branch: 'invalid branch name',
      },
    })
    expect((await current()).instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('the memory ceiling is the admin-saved one', async () => {
    await shopWithWeb()
    await setResourceSettings(t.db, { memoryBudgetMb: 8192, maxServiceMemoryMb: 1024 }, root.id)
    expect(await save(ada, { ...SAME, memoryLimitMB: '1025' })).toEqual({
      fieldErrors: { memoryLimitMB: 'must be between 6 and 1024 MB' },
    })
    expect(await save(ada, { ...SAME, memoryLimitMB: '1024', intent: 'save-only' })).toHaveProperty('notice')
  })

  test('an outsider gets NotFound, with either intent and any values, and nothing changes', async () => {
    await shopWithWeb()
    const before = await current()
    for (const intent of ['save-deploy', 'save-only']) {
      for (const patch of [{ port: '3000' }, { port: 'abc' }, {}]) {
        await expect(save(bob, { ...SAME, ...patch, intent })).rejects.toBeInstanceOf(NotFoundError)
      }
    }
    expect((await current()).instance).toEqual(before.instance)
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('a service that does not exist, or one that belongs to another project, is NotFound', async () => {
    await shopWithWeb()
    await createProject(t.db, 'mine', bob.id)
    await expect(save(ada, SAME, 'shop', 'nothing')).rejects.toBeInstanceOf(NotFoundError)
    await expect(save(ada, SAME, 'shop', '../x')).rejects.toBeInstanceOf(NotFoundError)
    await expect(save(ada, SAME, 'nothing', 'web')).rejects.toBeInstanceOf(NotFoundError)
    // `web` exists, but in `shop`, not in bob's project.
    await expect(save(bob, SAME, 'mine', 'web')).rejects.toBeInstanceOf(NotFoundError)
    await expect(doSaveServiceSettings(t.db, actorOf(ada), 'shop', undefined as unknown as string, SAME, SITE)).rejects.toBeInstanceOf(NotFoundError)
    expect(await deploymentRows()).toEqual([])
  })

  test('an admin who is not a member can change settings', async () => {
    await shopWithWeb()
    await save(root, { ...SAME, port: '3000' })
    expect((await deploymentRows())[0]).toMatchObject({ created_by_id: root.id })
    expect((await auditRows())[0]).toMatchObject({ actor_id: root.id, action: 'service.update' })
  })

  test('a deployment that is already waiting is replaced by the new one, as for any newer deployment', async () => {
    await shopWithWeb()
    await save(ada, { ...SAME, port: '3000' })
    await save(ada, { ...SAME, port: '3001' })
    expect((await deploymentRows()).map((d) => d.status)).toEqual(['SKIPPED', 'QUEUED'])
  })
})

describe('doDeleteService', () => {
  const del = (actor: SafeUser, input: { confirm?: string }, project = 'shop', service = 'web') =>
    doDeleteService(t.db, actorOf(actor), project, service, input, SITE)

  test('deletes the service when its name is typed (spaces around it are ignored) and records service.delete', async () => {
    await adasProject()
    const { service, instance } = await addService()
    await addService('shop', 'api')
    await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'manual' })
    await t.sql`delete from audit_events`

    expect(await del(ada, { confirm: '  web ' })).toEqual({})
    expect(await serviceNames()).toEqual(['api'])
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'service.delete',
        target_type: 'service',
        target_id: service.id,
        metadata: { project: 'shop', service: 'web' },
      },
    ])
  })

  test.each([
    ['nothing', undefined],
    ['an empty box', ''],
    ['only spaces', '   '],
    ['another name', 'api'],
    ['a different case', 'Web'],
    ['part of the name', 'we'],
    ['the name with extra text', 'web please'],
    ['the project name', 'shop'],
  ])('with %s typed the service stays and the answer says to type the name', async (_what, confirm) => {
    await adasProject()
    await addService()
    expect(await del(ada, { confirm })).toEqual({ error: 'type the service name to confirm' })
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditRows()).toEqual([])
  })

  test.each([['BUILDING'], ['DEPLOYING']] as const)(
    'a deployment that is %s blocks the delete: the validation message is shown and nothing is recorded',
    async (status) => {
      await adasProject()
      const { instance } = await addService()
      const queued = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
      await claimNextDeployment(t.db)
      await setDeploymentStatus(t.db, queued.id, 'BUILDING')
      if (status === 'DEPLOYING') await setDeploymentStatus(t.db, queued.id, 'DEPLOYING')

      expect(await del(ada, { confirm: 'web' })).toEqual({ error: 'wait for the running deployment to finish' })
      expect(await serviceNames()).toEqual(['web'])
      expect(await auditRows()).toEqual([])
    },
  )

  test('a deployment that only waits in the queue does not block it', async () => {
    await adasProject()
    const { instance } = await addService()
    await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    expect(await del(ada, { confirm: 'web' })).toEqual({})
    expect(await serviceNames()).toEqual([])
  })

  test('an outsider gets NotFound, with or without the right confirmation, and nothing is deleted', async () => {
    await adasProject()
    await addService()
    await expect(del(bob, { confirm: 'web' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(del(bob, { confirm: 'wrong' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditRows()).toEqual([])
  })

  test('a missing or foreign or malformed service looks the same as one the actor may not see', async () => {
    await adasProject()
    await addService()
    await createProject(t.db, 'mine', bob.id)
    const attempts = [
      del(bob, { confirm: 'web' }),
      del(ada, { confirm: 'nothing' }, 'shop', 'nothing'),
      del(ada, { confirm: '../x' }, 'shop', '../x'),
      del(bob, { confirm: 'web' }, 'mine', 'web'),
      del(ada, { confirm: 'web' }, 'nothing', 'web'),
    ]
    const errors = await Promise.all(attempts.map((p) => p.catch((e: unknown) => e)))
    for (const error of errors) expect(error).toBeInstanceOf(NotFoundError)
    expect(new Set(errors.map((e) => (e as Error).message)).size).toBe(1)
    expect(await serviceNames()).toEqual(['web'])
  })

  test('an admin who is not a member can delete', async () => {
    await adasProject()
    await addService()
    expect(await del(root, { confirm: 'web' })).toEqual({})
    expect(await serviceNames()).toEqual([])
    expect((await auditRows())[0]).toMatchObject({ actor_id: root.id, action: 'service.delete' })
  })

  test('failing to record the audit event is logged and the delete stands', async () => {
    await adasProject()
    await addService()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      expect(await del(ada, { confirm: 'web' })).toEqual({})
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(await serviceNames()).toEqual([])
    expect(String(log.mock.calls[0]![0])).toContain('service.delete')
  })
})
