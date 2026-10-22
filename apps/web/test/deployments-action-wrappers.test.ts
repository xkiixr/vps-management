import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  createUser,
  enqueueDeployment,
  setDeploymentStatus,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'

// The server action wrappers need Next's request scope (headers, the session cookie, the cache), which does not
// exist in a unit test: those are replaced here, and the rest (origin check, session guard, access rules, audit,
// notFound(), the generic error) is the real code. See services-action-wrappers.test.ts.
const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  origin: 'https://panel.example.com' as string | null,
  user: undefined as unknown,
  order: [] as string[],
  revalidatePath: vi.fn<(path: string) => void>(),
}))

vi.mock('next/headers', () => ({
  headers: async () => new Headers(mocks.origin === null ? {} : { origin: mocks.origin }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/server/config', () => ({
  webConfig: () => ({ panelOrigin: 'https://panel.example.com', appsDomain: 'apps.example.com', httpsPort: 443 }),
}))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))
vi.mock('@/server/session', () => ({
  resolveSessionUser: async () => {
    mocks.order.push('session')
    return mocks.user
  },
}))

import { deployAction, restartAction, rollbackAction } from '@/server/actions/deployments'
import { GENERIC_ERROR } from '@/server/errors'
import { ForbiddenError } from '@/server/origin'
import { nextErrorDigest, NOT_FOUND_DIGEST, PASSWORD, redirectTarget } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})

let ada: SafeUser
let bob: SafeUser
beforeEach(async () => {
  await t.reset()
  ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
  bob = await createUser(t.db, { email: 'bob@example.com', name: 'Bob', role: 'member', password: PASSWORD })
  mocks.user = ada
  mocks.origin = 'https://panel.example.com'
  mocks.order.length = 0
  mocks.revalidatePath.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const NO_STATE = {}
const NO_FORM = new FormData()
const OTHER_ID = '00000000-0000-4000-8000-000000000001'

const auditActions = async () => (await t.sql`select action from audit_events order by id`).map((row) => row.action)
const triggers = async () => (await t.sql`select trigger from deployments order by created_at, id`).map((row) => row.trigger)

// Ada's `shop/web` with one live deployment (that has an image); returns the live deployment's id.
async function shopWithLiveWeb() {
  await createProject(t.db, 'shop', ada.id)
  const { instance } = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  const queued = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
  await claimNextDeployment(t.db)
  await setDeploymentStatus(t.db, queued.id, 'BUILDING')
  await setDeploymentStatus(t.db, queued.id, 'DEPLOYING', { imageTag: 'img:1' })
  await setDeploymentStatus(t.db, queued.id, 'SUCCESS', { containerName: 'vpsm-web-1' })
  return { instance, live: queued }
}

const attempts: [string, () => Promise<unknown>][] = [
  ['deployAction', () => deployAction('shop', 'web', NO_STATE, NO_FORM)],
  ['restartAction', () => restartAction('shop', 'web', NO_STATE, NO_FORM)],
  ['rollbackAction', () => rollbackAction('shop', 'web', OTHER_ID, NO_STATE, NO_FORM)],
]

describe('every action starts with the same-origin check, then the session', () => {
  test.each(attempts)('%s refuses a missing, foreign or lookalike Origin before reading the session', async (_name, run) => {
    await shopWithLiveWeb()
    for (const origin of [null, 'https://evil.example.com', 'https://panel.example.com/', 'http://panel.example.com', 'null']) {
      mocks.origin = origin
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError)
    }
    expect(mocks.order).toEqual([])
    expect(await triggers()).toEqual(['push'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test.each(attempts)('%s sends someone who is not signed in to /login and does nothing', async (_name, run) => {
    await shopWithLiveWeb()
    mocks.user = null
    expect(redirectTarget(await nextErrorDigest(run))).toBe('/login')
    expect(mocks.order).toEqual(['session'])
    expect(await triggers()).toEqual(['push'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test.each(attempts)('%s gives someone outside the project the 404 page and changes nothing', async (_name, run) => {
    await shopWithLiveWeb()
    mocks.user = bob
    expect(await nextErrorDigest(run)).toBe(NOT_FOUND_DIGEST)
    expect(await triggers()).toEqual(['push'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('deployAction', () => {
  test('queues a manual deployment, says so and refreshes the service and project pages', async () => {
    await shopWithLiveWeb()
    expect(await deployAction('shop', 'web', NO_STATE, NO_FORM)).toEqual({ notice: 'Deployment queued.' })
    expect(await triggers()).toEqual(['push', 'manual'])
    expect(await auditActions()).toEqual(['deployment.deploy'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/services/web')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
  })

  test('a service that does not exist is the 404 page', async () => {
    await shopWithLiveWeb()
    expect(await nextErrorDigest(() => deployAction('shop', 'nothing', NO_STATE, NO_FORM))).toBe(NOT_FOUND_DIGEST)
  })

  test('an unexpected failure is the generic message, logged without the statement parameters', async () => {
    await shopWithLiveWeb()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table deployments rename to deployments_away`
    try {
      expect(await deployAction('shop', 'web', NO_STATE, NO_FORM)).toEqual({ error: GENERIC_ERROR })
    } finally {
      await t.sql`alter table deployments_away rename to deployments`
    }
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('deploying')
    expect(logged).not.toContain('params')
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('restartAction', () => {
  test('queues a restart of the live deployment, says so and refreshes the pages', async () => {
    await shopWithLiveWeb()
    expect(await restartAction('shop', 'web', NO_STATE, NO_FORM)).toEqual({ notice: 'Restart queued.' })
    expect(await triggers()).toEqual(['push', 'restart'])
    expect(await auditActions()).toEqual(['deployment.restart'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/services/web')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
  })

  test('with nothing running it says so, queues nothing and refreshes nothing', async () => {
    await createProject(t.db, 'shop', ada.id)
    await createAppService(t.db, {
      projectName: 'shop',
      serviceName: 'web',
      source: { repo: 'acme/web', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    expect(await restartAction('shop', 'web', NO_STATE, NO_FORM)).toEqual({ error: 'nothing is running to restart' })
    expect(await triggers()).toEqual([])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('while a deployment is waiting the refusal of the queue is shown as it is', async () => {
    const { instance } = await shopWithLiveWeb()
    await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    expect(await restartAction('shop', 'web', NO_STATE, NO_FORM)).toEqual({
      error: 'a deployment is already queued for this service',
    })
    expect(await triggers()).toEqual(['push', 'push'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('rollbackAction', () => {
  test('queues a rollback to the deployment bound to it, says so and refreshes the pages', async () => {
    const { live } = await shopWithLiveWeb()
    expect(await rollbackAction('shop', 'web', live.id, NO_STATE, NO_FORM)).toEqual({ notice: 'Rollback queued.' })
    expect(await triggers()).toEqual(['push', 'rollback'])
    expect(await auditActions()).toEqual(['deployment.rollback'])
    const [row] = await t.sql`select rollback_of_id from deployments where trigger = 'rollback'`
    expect(row!.rollback_of_id).toBe(live.id)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/services/web')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
  })

  test('a deployment without an image is refused with the reason', async () => {
    const { instance } = await shopWithLiveWeb()
    const queued = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'manual' })
    expect(await rollbackAction('shop', 'web', queued.id, NO_STATE, NO_FORM)).toEqual({
      error: 'this deployment has no image to roll back to',
    })
    expect(await triggers()).toEqual(['push', 'manual'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('a deployment of another service of the project, or one that does not exist, is the 404 page', async () => {
    await shopWithLiveWeb()
    const { instance: api } = await createAppService(t.db, {
      projectName: 'shop',
      serviceName: 'api',
      source: { repo: 'acme/api', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    const apis = await enqueueDeployment(t.db, { serviceInstanceId: api.id, trigger: 'push' })
    for (const id of [apis.id, OTHER_ID, 'not-a-uuid']) {
      expect(await nextErrorDigest(() => rollbackAction('shop', 'web', id, NO_STATE, NO_FORM))).toBe(NOT_FOUND_DIGEST)
    }
    expect(await triggers()).toEqual(['push', 'push'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})
