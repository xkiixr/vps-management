import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import {
  appendDeploymentLogs,
  claimNextDeployment,
  CLEANUP_CHANNEL,
  createAppService,
  createProject,
  deleteProject,
  deleteService,
  deploymentLogs,
  deployments,
  domains,
  enqueueDeployment,
  environments,
  projectMembers,
  type Project,
  projects,
  serviceInstances,
  services,
  setDeploymentStatus,
  users,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'
import { listenDuring, waitForLockWaiters } from './helpers'

const t = await setupTestDb()
const { db } = t
afterAll(() => t.close())

const RUNNING_MESSAGE = 'wait for the running deployment to finish'

let shop: Project
let webId: string
let apiId: string

const addService = async (projectName: string, serviceName: string) =>
  (
    await createAppService(db, {
      projectName,
      serviceName,
      source: { repo: 'acme/web', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
  ).instance.id

beforeEach(async () => {
  await t.reset()
  shop = await createProject(db, 'shop')
  webId = await addService('shop', 'web')
  apiId = await addService('shop', 'api')
})

const enqueue = (serviceInstanceId: string) => enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })

async function liveDeployment(serviceInstanceId: string) {
  const d = await enqueue(serviceInstanceId)
  await setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: `vpsm/${serviceInstanceId}:${d.id}` })
  return setDeploymentStatus(db, d.id, 'SUCCESS', { containerName: `vpsm-x-${d.id.slice(0, 8)}` })
}

// Puts a deployment of the instance into a state in which a worker is working on it.
async function runningDeployment(serviceInstanceId: string, state: 'claimed' | 'BUILDING' | 'DEPLOYING') {
  const d = await enqueue(serviceInstanceId)
  expect((await claimNextDeployment(db))!.id).toBe(d.id)
  if (state !== 'claimed') await setDeploymentStatus(db, d.id, state)
  return d
}

async function serviceNames() {
  return (await db.select().from(services)).map((s) => s.name).sort()
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ValidationError)
  return error as Error
}

// --- deleteService -------------------------------------------------------------------------------------

test.each(['claimed', 'BUILDING', 'DEPLOYING'] as const)('deleteService refuses while a deployment is %s', async (state) => {
  await runningDeployment(webId, state)
  expect((await errorOf(deleteService(db, webId))).message).toBe(RUNNING_MESSAGE)
  expect(await serviceNames()).toEqual(['api', 'web'])
  expect(await db.select().from(deployments)).toHaveLength(1)
})

test('a running deployment of another service does not stop deleteService', async () => {
  await runningDeployment(apiId, 'BUILDING')
  await deleteService(db, webId)
  expect(await serviceNames()).toEqual(['api'])
})

test('deleteService deletes a deployment that is still waiting in the queue', async () => {
  await enqueue(webId)
  await deleteService(db, webId)
  expect(await serviceNames()).toEqual(['api'])
  expect(await claimNextDeployment(db)).toBeNull()
})

test('deleteService removes rows and notifies cleanup', async () => {
  const live = await liveDeployment(webId)
  await appendDeploymentLogs(db, live.id, 'build', ['a', 'b'])
  await db.insert(domains).values({ serviceInstanceId: webId, hostname: 'shop.example.org', kind: 'custom' })
  const apiLive = await liveDeployment(apiId)

  const payloads = await listenDuring(t.sql, CLEANUP_CHANNEL, () => deleteService(db, webId))
  expect(payloads).toEqual([''])
  expect(await serviceNames()).toEqual(['api'])
  expect((await db.select().from(serviceInstances)).map((i) => i.id)).toEqual([apiId])
  expect((await db.select().from(deployments)).map((d) => d.id)).toEqual([apiLive.id])
  expect((await db.select().from(domains)).map((d) => d.hostname)).toEqual(['api-shop.apps.example.com'])
  expect(await db.select().from(deploymentLogs)).toHaveLength(0)
})

test('a refused deleteService does not notify cleanup', async () => {
  await runningDeployment(webId, 'BUILDING')
  const payloads = await listenDuring(t.sql, CLEANUP_CHANNEL, () => deleteService(db, webId).catch(() => undefined))
  expect(payloads).toEqual([])
})

test('deleteService refuses an unknown service', async () => {
  for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
    expect((await errorOf(deleteService(db, id))).message).toBe('service not found')
  }
})

// --- deleteProject -------------------------------------------------------------------------------------

test('deleteProject refuses while any of its services has a running deployment', async () => {
  await liveDeployment(webId)
  await runningDeployment(apiId, 'DEPLOYING')
  expect((await errorOf(deleteProject(db, shop.id))).message).toBe(RUNNING_MESSAGE)
  expect(await db.select().from(projects)).toHaveLength(1)
  expect(await serviceNames()).toEqual(['api', 'web'])
})

test('deleteProject removes the project with everything in it and notifies cleanup', async () => {
  const [alice] = await db
    .insert(users)
    .values({ email: 'alice@example.com', name: 'alice', role: 'member', passwordHash: 'x' })
    .returning()
  await db.insert(projectMembers).values({ projectId: shop.id, userId: alice!.id })
  await liveDeployment(webId)
  await enqueue(apiId)
  const blog = await createProject(db, 'blog')
  const docsId = await addService('blog', 'docs')

  const payloads = await listenDuring(t.sql, CLEANUP_CHANNEL, () => deleteProject(db, shop.id))
  expect(payloads).toEqual([''])
  expect((await db.select().from(projects)).map((p) => p.name)).toEqual(['blog'])
  expect((await db.select().from(environments)).map((e) => e.projectId)).toEqual([blog.id])
  expect(await serviceNames()).toEqual(['docs'])
  expect((await db.select().from(serviceInstances)).map((i) => i.id)).toEqual([docsId])
  expect(await db.select().from(deployments)).toHaveLength(0)
  expect(await db.select().from(projectMembers)).toHaveLength(0)
  expect(await db.select().from(users)).toHaveLength(1)
})

test('deleteProject refuses an unknown project', async () => {
  for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
    expect((await errorOf(deleteProject(db, id))).message).toBe('project not found')
  }
})

// --- races with the worker and with enqueues -----------------------------------------------------------

test.each([
  ['deleteService', () => deleteService(db, webId)],
  ['deleteProject', () => deleteProject(db, shop.id)],
] as const)('%s waits for a claim in progress and then refuses', async (_name, remove) => {
  const queued = await enqueue(webId)
  let removing: Promise<Error> | undefined
  await t.sql.begin(async (tx) => {
    // What claimNextDeployment does, paused between locking the queued row and stamping it.
    await tx`select id from deployments where id = ${queued.id} for update skip locked`
    removing = errorOf(remove())
    await waitForLockWaiters(t.sql, 1)
    await tx`update deployments set claimed_at = now(), started_at = now() where id = ${queued.id}`
  })
  expect((await removing!).message).toBe(RUNNING_MESSAGE)
  expect(await serviceNames()).toEqual(['api', 'web'])
  expect((await db.select().from(deployments).where(eq(deployments.id, queued.id)))[0]!.claimedAt).not.toBeNull()
})

test('while deleteService runs, a claim skips its queued deployment and an enqueue finds no service', async () => {
  await enqueue(webId)
  let deleting: Promise<void> | undefined
  let enqueueing: Promise<unknown> | undefined
  let claimed: unknown
  await t.sql.begin(async (tx) => {
    // Holding a domain row stops deleteService inside its cascade, after it has taken its own locks.
    await tx`select id from domains where service_instance_id = ${webId} for update`
    deleting = deleteService(db, webId)
    await waitForLockWaiters(t.sql, 1)
    claimed = await claimNextDeployment(db)
    enqueueing = enqueue(webId).catch((e: unknown) => e)
    await waitForLockWaiters(t.sql, 2)
  })
  await deleting
  expect(claimed).toBeNull()
  expect(await enqueueing).toMatchObject({ message: `service instance ${webId} not found` })
  expect(await serviceNames()).toEqual(['api'])
  expect(await db.select().from(deployments)).toHaveLength(0)
})

test('an enqueue cannot slip in while deleteService is checking for running deployments', async () => {
  const queued = await enqueue(webId)
  let deleting: Promise<void> | undefined
  let enqueueing: Promise<unknown> | undefined
  await t.sql.begin(async (tx) => {
    // A KEY SHARE lock pauses deleteService at its FOR UPDATE check without stopping enqueue's UPDATE of the row,
    // so enqueue can only be held up by deleteService's lock on the instance.
    await tx`select id from deployments where id = ${queued.id} for key share`
    deleting = deleteService(db, webId)
    await waitForLockWaiters(t.sql, 1)
    enqueueing = enqueue(webId).catch((e: unknown) => e)
    await waitForLockWaiters(t.sql, 2)
  })
  await deleting
  expect(await enqueueing).toMatchObject({ message: `service instance ${webId} not found` })
  expect(await db.select().from(deployments)).toHaveLength(0)
})

test('deleteService racing enqueues and worker claims never deadlocks and never deletes claimed work', async () => {
  // A worker claims the next deployment and starts building it straight away.
  const claimAndStart = async () => {
    const d = await claimNextDeployment(db)
    if (d) await setDeploymentStatus(db, d.id, 'BUILDING')
    return d
  }
  // Random start delays move the race around, so rounds end on both sides of it.
  const jittered = <T>(fn: () => Promise<T>) =>
    new Promise((resolve) => setTimeout(resolve, Math.random() * 5)).then(fn)
  for (let round = 0; round < 20; round++) {
    await db.delete(services).where(eq(services.name, 'web'))
    const id = await addService('shop', 'web')
    await enqueue(id)

    const [deleted, enqueued, ...claims] = await Promise.allSettled([
      jittered(() => deleteService(db, id)),
      jittered(() => enqueue(id)),
      jittered(claimAndStart),
      jittered(claimAndStart),
    ])
    const claimedIds = claims.map((c) => {
      expect(c.status).toBe('fulfilled')
      return (c as PromiseFulfilledResult<{ id: string } | null>).value?.id
    })
    const remaining = await db.select().from(deployments).where(eq(deployments.serviceInstanceId, id))
    if (deleted.status === 'fulfilled') {
      expect(claimedIds.filter(Boolean)).toEqual([])
      expect(remaining).toEqual([])
      if (enqueued.status === 'rejected') expect((enqueued.reason as Error).message).toMatch(/not found$/)
    } else {
      expect(deleted.reason).toBeInstanceOf(ValidationError)
      expect((deleted.reason as Error).message).toBe(RUNNING_MESSAGE)
      expect(enqueued.status).toBe('fulfilled')
      for (const claimedId of claimedIds.filter(Boolean)) expect(remaining.map((d) => d.id)).toContain(claimedId)
      expect(claimedIds.some(Boolean)).toBe(true)
    }
  }
})
