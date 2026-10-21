import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_BUILD_CONFIG, DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import {
  deploymentLogs,
  deployments,
  domains,
  environments,
  projects,
  serviceInstances,
  services,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
beforeEach(() => t.reset())
afterAll(() => t.close())

async function createInstance(projectName: string, serviceName: string) {
  const [project] = await t.db.insert(projects).values({ name: projectName }).returning()
  const [environment] = await t.db
    .insert(environments)
    .values({ projectId: project!.id, name: 'production' })
    .returning()
  const [service] = await t.db
    .insert(services)
    .values({ projectId: project!.id, name: serviceName })
    .returning()
  const [instance] = await t.db
    .insert(serviceInstances)
    .values({
      serviceId: service!.id,
      environmentId: environment!.id,
      source: { repo: 'acme/web', branch: 'main' },
      build: DEFAULT_BUILD_CONFIG,
      deploy: DEFAULT_DEPLOY_CONFIG,
    })
    .returning()
  return { project: project!, environment: environment!, service: service!, instance: instance! }
}

test('project names are unique', async () => {
  await t.db.insert(projects).values({ name: 'shop' })
  await expect(t.db.insert(projects).values({ name: 'shop' })).rejects.toThrow()
})

test('service names are unique per project but reusable across projects', async () => {
  const [shop] = await t.db.insert(projects).values({ name: 'shop' }).returning()
  const [blog] = await t.db.insert(projects).values({ name: 'blog' }).returning()
  await t.db.insert(services).values({ projectId: shop!.id, name: 'web' })
  await t.db.insert(services).values({ projectId: blog!.id, name: 'web' })
  await expect(t.db.insert(services).values({ projectId: shop!.id, name: 'web' })).rejects.toThrow()
})

test('hostnames are globally unique', async () => {
  const a = await createInstance('shop', 'web')
  const b = await createInstance('blog', 'web')
  await t.db
    .insert(domains)
    .values({ serviceInstanceId: a.instance.id, hostname: 'web.apps.example.com', kind: 'generated' })
  await expect(
    t.db
      .insert(domains)
      .values({ serviceInstanceId: b.instance.id, hostname: 'web.apps.example.com', kind: 'custom' }),
  ).rejects.toThrow()
})

test('deleting a project cascades to deployments', async () => {
  const { project, instance } = await createInstance('shop', 'web')
  await t.db.insert(deployments).values({ serviceInstanceId: instance.id, trigger: 'manual' })
  expect(await t.db.select().from(deployments)).toHaveLength(1)
  await t.db.delete(projects).where(eq(projects.id, project.id))
  expect(await t.db.select().from(deployments)).toHaveLength(0)
})

test('deployment status defaults to QUEUED', async () => {
  const { instance } = await createInstance('shop', 'web')
  const [deployment] = await t.db
    .insert(deployments)
    .values({ serviceInstanceId: instance.id, trigger: 'manual' })
    .returning()
  expect(deployment!.status).toBe('QUEUED')
})

async function createDeployment(projectName: string) {
  const { project, instance } = await createInstance(projectName, 'web')
  const [deployment] = await t.db
    .insert(deployments)
    .values({ serviceInstanceId: instance.id, trigger: 'manual' })
    .returning()
  return { project, instance, deployment: deployment! }
}

test('check constraints reject unknown service kinds, log phases and domain kinds', async () => {
  const { project, instance, deployment } = await createDeployment('shop')
  await expect(
    t.db.insert(services).values({ projectId: project.id, name: 'cache', kind: 'mysql' as 'app' }),
  ).rejects.toThrow()
  await expect(
    t.db.insert(deploymentLogs).values({ deploymentId: deployment.id, phase: 'run' as 'build', line: 'x' }),
  ).rejects.toThrow()
  await expect(
    t.db
      .insert(domains)
      .values({ serviceInstanceId: instance.id, hostname: 'x.example.com', kind: 'other' as 'custom' }),
  ).rejects.toThrow()
})

test('reset empties every table and restarts log ids', async () => {
  const first = await createDeployment('shop')
  await t.db.insert(deploymentLogs).values({ deploymentId: first.deployment.id, phase: 'build', line: 'a' })
  await t.db.insert(deploymentLogs).values({ deploymentId: first.deployment.id, phase: 'build', line: 'b' })

  await t.reset()

  expect(await t.db.select().from(projects)).toHaveLength(0)
  expect(await t.db.select().from(deploymentLogs)).toHaveLength(0)
  const second = await createDeployment('shop')
  const [log] = await t.db
    .insert(deploymentLogs)
    .values({ deploymentId: second.deployment.id, phase: 'deploy', line: 'c' })
    .returning()
  expect(log!.id).toBe(1)
})
