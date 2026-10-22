import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_BUILD_CONFIG, DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import {
  configChangedSinceLiveDeploy,
  createAppService,
  createProject,
  domains,
  enqueueDeployment,
  findService,
  listServices,
  type Project,
  type ServiceRow,
  serviceInstances,
  setDeploymentStatus,
  updateServiceConfig,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
const { db } = t
afterAll(() => t.close())

const APPS_DOMAIN = 'apps.example.com'
const OPTS = { httpsPort: 443 }
const LIMITS = { maxServiceMemoryMb: 2048 }

let shop: Project
let instanceId: string

const addService = (projectName: string, serviceName: string) =>
  createAppService(db, {
    projectName,
    serviceName,
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: APPS_DOMAIN,
  })

beforeEach(async () => {
  await t.reset()
  shop = await createProject(db, 'shop')
  instanceId = (await addService('shop', 'web')).instance.id
})

async function reload(id: string) {
  const [instance] = await db.select().from(serviceInstances).where(eq(serviceInstances.id, id))
  return instance!
}

// A deployment of the instance's current config that went live, with the snapshot the worker stores.
async function deployCurrentConfig(id: string) {
  const { source, build, deploy } = await reload(id)
  const d = await enqueueDeployment(db, { serviceInstanceId: id, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'BUILDING')
  await setDeploymentStatus(db, d.id, 'DEPLOYING', {
    imageTag: `vpsm/${id}:${d.id}`,
    configSnapshot: { source, build, deploy, builder: 'railpack' },
  })
  return setDeploymentStatus(db, d.id, 'SUCCESS', { containerName: `vpsm-web-${d.id.slice(0, 8)}` })
}

async function row(): Promise<ServiceRow> {
  return (await findService(db, shop.id, 'web', OPTS))!
}

// --- listing -------------------------------------------------------------------------------------------

test('listServices lists the project services by name with their public URL', async () => {
  await addService('shop', 'api')
  const rows = await listServices(db, shop.id, OPTS)
  expect(rows.map((r) => [r.service.name, r.url, r.latest, r.live])).toEqual([
    ['api', 'https://api-shop.apps.example.com', null, null],
    ['web', 'https://web-shop.apps.example.com', null, null],
  ])
  expect(rows[1]!.instance.id).toBe(instanceId)
  expect(rows[1]!.service.projectId).toBe(shop.id)
})

test('the URL carries a non-default HTTPS port', async () => {
  const [web] = await listServices(db, shop.id, { httpsPort: 8443 })
  expect(web!.url).toBe('https://web-shop.apps.example.com:8443')
})

test('the URL uses the first generated domain by hostname and never a custom one', async () => {
  await db.insert(domains).values([
    { serviceInstanceId: instanceId, hostname: 'aaa-custom.example.org', kind: 'custom' },
    { serviceInstanceId: instanceId, hostname: 'aaa.apps.example.com', kind: 'generated' },
  ])
  expect((await row()).url).toBe('https://aaa.apps.example.com')

  await db.delete(domains).where(eq(domains.kind, 'generated'))
  expect((await row()).url).toBeNull()
})

test('latest is the newest deployment and live the newest successful one', async () => {
  const live = await deployCurrentConfig(instanceId)
  const queued = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'push' })
  const r = await row()
  expect(r.latest).toEqual({ id: queued.id, status: 'QUEUED', createdAt: queued.createdAt })
  expect(r.live).toEqual({ id: live.id, imageTag: live.imageTag, configSnapshot: live.configSnapshot })

  await setDeploymentStatus(db, live.id, 'CRASHED')
  expect((await row()).live).toBeNull()
})

// --- current: what Restart starts again ----------------------------------------------------------------

test('current is the newest deployment that is running or has crashed, with its status and image', async () => {
  expect((await row()).current).toBeNull()

  const deployed = await deployCurrentConfig(instanceId)
  expect((await row()).current).toEqual({ id: deployed.id, status: 'SUCCESS', imageTag: deployed.imageTag })

  await setDeploymentStatus(db, deployed.id, 'CRASHED')
  const crashed = await row()
  expect(crashed.live).toBeNull()
  expect(crashed.current).toEqual({ id: deployed.id, status: 'CRASHED', imageTag: deployed.imageTag })
})

test('current ignores newer deployments that failed, are building or are waiting', async () => {
  const deployed = await deployCurrentConfig(instanceId)
  await setDeploymentStatus(db, deployed.id, 'CRASHED')

  const failed = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'manual' })
  await setDeploymentStatus(db, failed.id, 'BUILDING')
  await setDeploymentStatus(db, failed.id, 'DEPLOYING', { imageTag: `vpsm/${instanceId}:${failed.id}` })
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'health check failed' })
  const building = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'manual' })
  await setDeploymentStatus(db, building.id, 'BUILDING')
  const waiting = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'push' })

  const r = await row()
  expect(r.latest?.id).toBe(waiting.id)
  expect(r.current).toEqual({ id: deployed.id, status: 'CRASHED', imageTag: deployed.imageTag })
})

test('current is the newest of them, as the worker picks what a restart runs: a crash replaced by a deploy is not it', async () => {
  const crashed = await deployCurrentConfig(instanceId)
  await setDeploymentStatus(db, crashed.id, 'CRASHED')
  const live = await deployCurrentConfig(instanceId)
  expect((await row()).current).toEqual({ id: live.id, status: 'SUCCESS', imageTag: live.imageTag })
})

test('current belongs to its own service', async () => {
  await deployCurrentConfig(instanceId)
  await addService('shop', 'api')
  const rows = await listServices(db, shop.id, OPTS)
  expect(rows.map((r) => [r.service.name, r.current?.status ?? null])).toEqual([
    ['api', null],
    ['web', 'SUCCESS'],
  ])
})

test('listServices only lists the given project', async () => {
  await createProject(db, 'blog')
  await addService('blog', 'docs')
  expect((await listServices(db, shop.id, OPTS)).map((r) => r.service.name)).toEqual(['web'])
})

test('findService returns the same row as listServices', async () => {
  await deployCurrentConfig(instanceId)
  expect(await findService(db, shop.id, 'web', OPTS)).toEqual((await listServices(db, shop.id, OPTS))[0])
})

test('findService returns null for an unknown name, another project service and impossible names', async () => {
  await createProject(db, 'blog')
  await addService('blog', 'docs')
  for (const name of ['ghost', 'docs', 'we\u0000b', 'Web']) expect(await findService(db, shop.id, name, OPTS)).toBeNull()
})

// --- configChangedSinceLiveDeploy -------------------------------------------------------------------------

test('configChangedSinceLiveDeploy is false without a live deployment', async () => {
  await updateServiceConfig(db, instanceId, { branch: 'dev' }, LIMITS)
  expect(configChangedSinceLiveDeploy(await row())).toBe(false)
})

test('configChangedSinceLiveDeploy detects saved-but-not-deployed changes', async () => {
  await deployCurrentConfig(instanceId)
  expect(configChangedSinceLiveDeploy(await row())).toBe(false)

  expect(await updateServiceConfig(db, instanceId, { healthcheckPath: '/health' }, LIMITS)).toEqual({ ok: true })
  expect(configChangedSinceLiveDeploy(await row())).toBe(true)

  await deployCurrentConfig(instanceId)
  expect(configChangedSinceLiveDeploy(await row())).toBe(false)
})

function rowWith(instance: Partial<ServiceRow['instance']>, configSnapshot: unknown): ServiceRow {
  return {
    instance: {
      source: { repo: 'acme/web', branch: 'main' },
      build: DEFAULT_BUILD_CONFIG,
      deploy: DEFAULT_DEPLOY_CONFIG,
      ...instance,
    },
    live: { id: 'd', imageTag: 'vpsm/x:d', configSnapshot },
  } as ServiceRow
}

test('configChangedSinceLiveDeploy compares structurally, whatever the key order', () => {
  const reversed = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).reverse())
  const snapshot = {
    builder: 'railpack',
    deploy: reversed(DEFAULT_DEPLOY_CONFIG),
    build: reversed(DEFAULT_BUILD_CONFIG),
    source: { branch: 'main', repo: 'acme/web' },
  }
  expect(configChangedSinceLiveDeploy(rowWith({}, snapshot))).toBe(false)
  expect(configChangedSinceLiveDeploy(rowWith({ deploy: { ...DEFAULT_DEPLOY_CONFIG, port: 3000 } }, snapshot))).toBe(true)
  expect(configChangedSinceLiveDeploy(rowWith({ source: null }, snapshot))).toBe(true)
  expect(configChangedSinceLiveDeploy(rowWith({ source: null }, { ...snapshot, source: null }))).toBe(false)
  expect(configChangedSinceLiveDeploy(rowWith({ build: { builder: 'dockerfile' } }, snapshot))).toBe(true)
})

test('configChangedSinceLiveDeploy is false when the live deployment has no snapshot to compare with', () => {
  expect(configChangedSinceLiveDeploy(rowWith({}, null))).toBe(false)
})

// --- updateServiceConfig ----------------------------------------------------------------------------------

test('updateServiceConfig refuses invalid values and saves nothing', async () => {
  const r = await updateServiceConfig(db, instanceId, { port: 70000, healthcheckPath: 'x' }, { maxServiceMemoryMb: 2048 })
  expect(r).toEqual({ ok: false, errors: { port: 'must be between 1 and 65535', healthcheckPath: 'must start with /' } })
  expect((await reload(instanceId)).deploy.port).toBe(8080)
})

test('updateServiceConfig keeps every valid field of a refused patch unsaved too', async () => {
  const r = await updateServiceConfig(db, instanceId, { branch: 'dev', memoryLimitMB: 4096 }, LIMITS)
  expect(r).toEqual({ ok: false, errors: { memoryLimitMB: 'must be between 6 and 2048 MB' } })
  const instance = await reload(instanceId)
  expect(instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
  expect(instance.deploy).toEqual(DEFAULT_DEPLOY_CONFIG)
})

test('updateServiceConfig saves trimmed source fields into source and the rest into deploy', async () => {
  const r = await updateServiceConfig(
    db,
    instanceId,
    {
      repo: ' acme/shop ',
      branch: 'dev ',
      rootDirectory: ' apps/web',
      healthcheckPath: '/health',
      port: 3000,
      memoryLimitMB: 1024,
      startCommand: ' node server.js ',
    },
    LIMITS,
  )
  expect(r).toEqual({ ok: true })
  const instance = await reload(instanceId)
  expect(instance.source).toEqual({ repo: 'acme/shop', branch: 'dev', rootDirectory: 'apps/web' })
  expect(instance.deploy).toEqual({
    ...DEFAULT_DEPLOY_CONFIG,
    healthcheckPath: '/health',
    port: 3000,
    memoryLimitMB: 1024,
    startCommand: 'node server.js',
  })
  expect(instance.build).toEqual(DEFAULT_BUILD_CONFIG)
})

test('an empty optional field removes its value and omitted fields are kept', async () => {
  const set = { rootDirectory: 'apps/web', healthcheckPath: '/health', startCommand: 'node server.js', port: 3000 }
  await updateServiceConfig(db, instanceId, set, LIMITS)
  const r = await updateServiceConfig(db, instanceId, { rootDirectory: '', healthcheckPath: '  ', startCommand: '' }, LIMITS)
  expect(r).toEqual({ ok: true })
  const instance = await reload(instanceId)
  expect(instance.source).toEqual({ repo: 'acme/web', branch: 'main' })
  expect(instance.deploy).toEqual({ ...DEFAULT_DEPLOY_CONFIG, port: 3000 })
})

test('repo and branch cannot be emptied', async () => {
  const r = await updateServiceConfig(db, instanceId, { repo: '', branch: ' ' }, LIMITS)
  expect(r).toEqual({ ok: false, errors: { repo: 'use the form owner/name', branch: 'branch is required' } })
})

test('control characters are refused in every string field and nothing is saved', async () => {
  const bad = 'a\u0000b'
  const r = await updateServiceConfig(
    db,
    instanceId,
    { repo: bad, branch: 'ma\nin', rootDirectory: bad, healthcheckPath: '/he\u007falth', startCommand: bad, port: 3000 },
    LIMITS,
  )
  const message = 'contains invalid characters'
  expect(r).toEqual({
    ok: false,
    errors: { repo: message, branch: message, rootDirectory: message, healthcheckPath: message, startCommand: message },
  })
  expect((await reload(instanceId)).deploy.port).toBe(8080)
})

test('a service without a source needs both repo and branch', async () => {
  await db.update(serviceInstances).set({ source: null }).where(eq(serviceInstances.id, instanceId))
  expect(await updateServiceConfig(db, instanceId, { branch: 'dev' }, LIMITS)).toEqual({
    ok: false,
    errors: { repo: 'use the form owner/name' },
  })
  expect(await updateServiceConfig(db, instanceId, { port: 3000 }, LIMITS)).toEqual({ ok: true })
  expect((await reload(instanceId)).source).toBeNull()
  expect(await updateServiceConfig(db, instanceId, { repo: 'acme/web', branch: 'dev' }, LIMITS)).toEqual({ ok: true })
  expect((await reload(instanceId)).source).toEqual({ repo: 'acme/web', branch: 'dev' })
})

test('updateServiceConfig refuses an unknown service', async () => {
  for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
    const error = await updateServiceConfig(db, id, { port: 3000 }, LIMITS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe('service not found')
  }
})
