import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_BUILD_CONFIG, DEFAULT_DEPLOY_CONFIG, type SourceConfig } from '@vpsm/core'
import {
  createAppService,
  createProject,
  domains,
  environments,
  findServiceInstance,
  projects,
  services,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
beforeEach(() => t.reset())
afterAll(() => t.close())

const APPS_DOMAIN = 'apps.example.com'
const source: SourceConfig = { repo: 'acme/web', branch: 'main' }

async function servicesOf(projectName: string) {
  const [project] = await t.db.select().from(projects).where(eq(projects.name, projectName))
  if (!project) return []
  return t.db.select().from(services).where(eq(services.projectId, project.id))
}

test('createProject creates production environment', async () => {
  const project = await createProject(t.db, 'shop')
  expect(project.name).toBe('shop')
  const envs = await t.db.select().from(environments).where(eq(environments.projectId, project.id))
  expect(envs.map((e) => e.name)).toEqual(['production'])
})

test('createProject rejects invalid names and creates nothing', async () => {
  await expect(createProject(t.db, 'My Shop')).rejects.toBeInstanceOf(ValidationError)
  expect(await t.db.select().from(projects)).toHaveLength(0)
  expect(await t.db.select().from(environments)).toHaveLength(0)
})

test('createProject rejects a duplicate project name', async () => {
  await createProject(t.db, 'shop')
  const error = await createProject(t.db, 'shop').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('project "shop" already exists')
  expect(await t.db.select().from(projects)).toHaveLength(1)
  expect(await t.db.select().from(environments)).toHaveLength(1)
})

test('createAppService applies defaults and generated domain', async () => {
  await createProject(t.db, 'shop')
  const { service, instance, domain } = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source,
    appsDomain: APPS_DOMAIN,
  })
  expect(service).toMatchObject({ name: 'web', kind: 'app' })
  expect(instance.source).toEqual(source)
  expect(instance.build).toEqual(DEFAULT_BUILD_CONFIG)
  expect(instance.deploy).toEqual(DEFAULT_DEPLOY_CONFIG)
  expect(domain).toMatchObject({
    hostname: 'web-shop.apps.example.com',
    kind: 'generated',
    serviceInstanceId: instance.id,
  })
})

test('createAppService attaches the instance to the production environment', async () => {
  const project = await createProject(t.db, 'shop')
  const { instance } = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source,
    appsDomain: APPS_DOMAIN,
  })
  const [production] = await t.db.select().from(environments).where(eq(environments.projectId, project.id))
  expect(instance.environmentId).toBe(production!.id)
})

test('createAppService merges overrides over defaults and ignores undefined values', async () => {
  await createProject(t.db, 'shop')
  const { instance } = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source,
    build: { builder: 'dockerfile', dockerfilePath: 'Dockerfile.prod' },
    deploy: { memoryLimitMB: 1024, port: undefined, startCommand: 'node server.js' },
    appsDomain: APPS_DOMAIN,
  })
  expect(instance.build).toEqual({ builder: 'dockerfile', dockerfilePath: 'Dockerfile.prod' })
  expect(instance.deploy).toEqual({ ...DEFAULT_DEPLOY_CONFIG, memoryLimitMB: 1024, startCommand: 'node server.js' })
})

test('createAppService rejects an unknown project and an invalid service name', async () => {
  await expect(
    createAppService(t.db, { projectName: 'ghost', serviceName: 'web', source, appsDomain: APPS_DOMAIN }),
  ).rejects.toThrow('project "ghost" not found')
  await createProject(t.db, 'shop')
  await expect(
    createAppService(t.db, { projectName: 'shop', serviceName: 'Web App', source, appsDomain: APPS_DOMAIN }),
  ).rejects.toBeInstanceOf(ValidationError)
  expect(await servicesOf('shop')).toHaveLength(0)
})

test('createAppService rejects duplicate service names', async () => {
  await createProject(t.db, 'shop')
  await createAppService(t.db, { projectName: 'shop', serviceName: 'web', source, appsDomain: APPS_DOMAIN })
  const error = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source,
    appsDomain: APPS_DOMAIN,
  }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('service "web" already exists in project "shop"')
  expect(await servicesOf('shop')).toHaveLength(1)
  expect(await t.db.select().from(domains)).toHaveLength(1)
})

test('createAppService rejects a generated hostname that another service already uses', async () => {
  // project 'c' + service 'a-b' -> a-b-c.apps.example.com ; project 'b-c' + service 'a' -> same hostname
  await createProject(t.db, 'c')
  await createProject(t.db, 'b-c')
  await createAppService(t.db, { projectName: 'c', serviceName: 'a-b', source, appsDomain: APPS_DOMAIN })
  const error = await createAppService(t.db, {
    projectName: 'b-c',
    serviceName: 'a',
    source,
    appsDomain: APPS_DOMAIN,
  }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('hostname a-b-c.apps.example.com is already used by another service')
  expect(await servicesOf('b-c')).toHaveLength(0)
})

test('findServiceInstance resolves names to the instance and its domains', async () => {
  await createProject(t.db, 'shop')
  const created = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source,
    appsDomain: APPS_DOMAIN,
  })
  await t.db
    .insert(domains)
    .values({ serviceInstanceId: created.instance.id, hostname: 'shop.example.org', kind: 'custom' })

  const found = await findServiceInstance(t.db, 'shop', 'web')
  expect(found).not.toBeNull()
  expect(found!.project.name).toBe('shop')
  expect(found!.environment.name).toBe('production')
  expect(found!.service.id).toBe(created.service.id)
  expect(found!.instance.id).toBe(created.instance.id)
  expect(found!.domains.map((d) => d.hostname).sort()).toEqual(['shop.example.org', 'web-shop.apps.example.com'])
})

test('findServiceInstance returns null for unknown project, service or environment', async () => {
  await createProject(t.db, 'shop')
  await createAppService(t.db, { projectName: 'shop', serviceName: 'web', source, appsDomain: APPS_DOMAIN })
  expect(await findServiceInstance(t.db, 'ghost', 'web')).toBeNull()
  expect(await findServiceInstance(t.db, 'shop', 'ghost')).toBeNull()
  expect(await findServiceInstance(t.db, 'shop', 'web', 'staging')).toBeNull()
})
