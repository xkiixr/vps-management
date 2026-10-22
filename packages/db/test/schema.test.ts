import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_BUILD_CONFIG, DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import {
  auditEvents,
  deploymentLogs,
  deployments,
  domains,
  environments,
  projectMembers,
  projects,
  serviceInstances,
  services,
  sessions,
  settings,
  users,
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

async function createUser(email: string, role: 'admin' | 'member' = 'member') {
  const [user] = await t.db
    .insert(users)
    .values({ email, name: email.split('@')[0]!, passwordHash: 'hash', role })
    .returning()
  return user!
}

test('user emails are unique', async () => {
  await createUser('ann@example.com')
  await expect(createUser('ann@example.com')).rejects.toMatchObject({ cause: { code: '23505' } })
})

test('check constraint rejects unknown user roles', async () => {
  await expect(
    t.db.insert(users).values({ email: 'x@example.com', name: 'x', passwordHash: 'h', role: 'owner' as 'admin' }),
  ).rejects.toThrow()
})

test('a new user is enabled and has an id and a creation time', async () => {
  const user = await createUser('ann@example.com')
  expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(user.disabledAt).toBeNull()
  expect(user.createdAt).toBeInstanceOf(Date)
})

test('deleting a user nulls deployments.created_by_id and audit actor', async () => {
  const user = await createUser('ann@example.com')
  const { instance } = await createInstance('shop', 'web')
  const [deployment] = await t.db
    .insert(deployments)
    .values({ serviceInstanceId: instance.id, trigger: 'manual', createdById: user.id })
    .returning()
  const [event] = await t.db
    .insert(auditEvents)
    .values({ actorId: user.id, action: 'service.deploy', targetType: 'service', targetId: 'web' })
    .returning()

  await t.db.delete(users).where(eq(users.id, user.id))

  const [afterDeployment] = await t.db.select().from(deployments).where(eq(deployments.id, deployment!.id))
  expect(afterDeployment!.createdById).toBeNull()
  const [afterEvent] = await t.db.select().from(auditEvents).where(eq(auditEvents.id, event!.id))
  expect(afterEvent!.actorId).toBeNull()
})

test('deployments.created_by_id must reference an existing user', async () => {
  const { instance } = await createInstance('shop', 'web')
  await expect(
    t.db.insert(deployments).values({
      serviceInstanceId: instance.id,
      trigger: 'manual',
      createdById: '00000000-0000-4000-8000-000000000000',
    }),
  ).rejects.toThrow()
})

test('deleting a user nulls settings.updated_by', async () => {
  const user = await createUser('ann@example.com')
  await t.db.insert(settings).values({ key: 'maxServiceMemoryMb', value: 2048, updatedBy: user.id })
  await t.db.delete(users).where(eq(users.id, user.id))
  const [row] = await t.db.select().from(settings)
  expect(row!.updatedBy).toBeNull()
  expect(row!.value).toBe(2048)
})

test('deleting a user cascades to their sessions', async () => {
  const user = await createUser('ann@example.com')
  await t.db.insert(sessions).values({ id: 'a'.repeat(64), userId: user.id, expiresAt: new Date(Date.now() + 1000) })
  expect(await t.db.select().from(sessions)).toHaveLength(1)
  await t.db.delete(users).where(eq(users.id, user.id))
  expect(await t.db.select().from(sessions)).toHaveLength(0)
})

test('deleting a project cascades members', async () => {
  const ann = await createUser('ann@example.com')
  const bob = await createUser('bob@example.com')
  const { project } = await createInstance('shop', 'web')
  await t.db.insert(projectMembers).values([
    { projectId: project.id, userId: ann.id },
    { projectId: project.id, userId: bob.id },
  ])
  expect(await t.db.select().from(projectMembers)).toHaveLength(2)

  await t.db.delete(projects).where(eq(projects.id, project.id))

  expect(await t.db.select().from(projectMembers)).toHaveLength(0)
  expect(await t.db.select().from(users)).toHaveLength(2)
})

test('deleting a user removes their memberships but keeps the project', async () => {
  const ann = await createUser('ann@example.com')
  const { project } = await createInstance('shop', 'web')
  await t.db.insert(projectMembers).values({ projectId: project.id, userId: ann.id })
  await t.db.delete(users).where(eq(users.id, ann.id))
  expect(await t.db.select().from(projectMembers)).toHaveLength(0)
  expect(await t.db.select().from(projects)).toHaveLength(1)
})

test('a user can be a member of a project only once', async () => {
  const ann = await createUser('ann@example.com')
  const { project } = await createInstance('shop', 'web')
  await t.db.insert(projectMembers).values({ projectId: project.id, userId: ann.id })
  await expect(t.db.insert(projectMembers).values({ projectId: project.id, userId: ann.id })).rejects.toMatchObject({
    cause: { code: '23505' },
  })
})

test('audit events get increasing ids and accept null target and metadata', async () => {
  const [first] = await t.db.insert(auditEvents).values({ action: 'user.login', targetType: 'user' }).returning()
  const [second] = await t.db
    .insert(auditEvents)
    .values({ action: 'project.create', targetType: 'project', targetId: 'p1', metadata: { name: 'shop' } })
    .returning()
  expect(second!.id).toBeGreaterThan(first!.id)
  expect(first!.actorId).toBeNull()
  expect(first!.metadata).toBeNull()
  expect(second!.metadata).toEqual({ name: 'shop' })
})

test('settings keys are unique', async () => {
  await t.db.insert(settings).values({ key: 'totalMemoryBudgetMb', value: 4096 })
  await expect(t.db.insert(settings).values({ key: 'totalMemoryBudgetMb', value: 1 })).rejects.toMatchObject({
    cause: { code: '23505' },
  })
})

test('the restart trigger is stored on a deployment', async () => {
  const { instance } = await createInstance('shop', 'web')
  const [deployment] = await t.db
    .insert(deployments)
    .values({ serviceInstanceId: instance.id, trigger: 'restart' })
    .returning()
  expect(deployment!.trigger).toBe('restart')
})
