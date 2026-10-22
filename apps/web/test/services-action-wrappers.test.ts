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
// exist in a unit test: those are replaced here, and the rest (origin check, session guard, parsing, access
// rules, audit, redirect()/notFound(), the generic error) is the real code.
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
// The session lookup is the one thing under the real guards that is replaced: `order` shows whether it ran.
vi.mock('@/server/session', () => ({
  resolveSessionUser: async () => {
    mocks.order.push('session')
    return mocks.user
  },
}))

import { createServiceAction, deleteServiceAction, saveServiceSettingsAction } from '@/server/actions/services'
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
  vi.stubEnv('MAX_SERVICE_MEMORY_MB', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}
const NO_STATE = {}

const serviceNames = async () => (await t.sql`select name from services order by name`).map((row) => row.name)
const auditActions = async () => (await t.sql`select action from audit_events order by id`).map((row) => row.action)
const triggers = async () => (await t.sql`select trigger from deployments order by created_at, id`).map((row) => row.trigger)

async function shopWithWeb() {
  await createProject(t.db, 'shop', ada.id)
  return createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
}

const SETTINGS = {
  repo: 'acme/web',
  branch: 'main',
  rootDirectory: '',
  healthcheckPath: '',
  port: '8080',
  memoryLimitMB: '512',
  startCommand: '',
}

const attempts: [string, () => Promise<unknown>][] = [
  ['createServiceAction', () => createServiceAction('shop', NO_STATE, form({ name: 'api', repo: 'acme/api' }))],
  ['saveServiceSettingsAction', () => saveServiceSettingsAction('shop', 'web', NO_STATE, form({ ...SETTINGS, port: '3000' }))],
  ['deleteServiceAction', () => deleteServiceAction('shop', 'web', NO_STATE, form({ confirm: 'web' }))],
]

describe('every action starts with the same-origin check, then the session', () => {
  test.each(attempts)('%s refuses a missing, foreign or lookalike Origin before reading the session', async (_name, run) => {
    await shopWithWeb()
    for (const origin of [null, 'https://evil.example.com', 'https://panel.example.com/', 'http://panel.example.com', 'null']) {
      mocks.origin = origin
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError)
    }
    expect(mocks.order).toEqual([])
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditActions()).toEqual([])
    expect(await triggers()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test.each(attempts)('%s sends someone who is not signed in to /login and does nothing', async (_name, run) => {
    await shopWithWeb()
    mocks.user = null
    expect(redirectTarget(await nextErrorDigest(run))).toBe('/login')
    expect(mocks.order).toEqual(['session'])
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditActions()).toEqual([])
    expect(await triggers()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test.each(attempts)('%s gives someone outside the project the 404 page and changes nothing', async (_name, run) => {
    await shopWithWeb()
    mocks.user = bob
    expect(await nextErrorDigest(run)).toBe(NOT_FOUND_DIGEST)
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditActions()).toEqual([])
    expect(await triggers()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('createServiceAction', () => {
  test('creates the service (fields trimmed), queues its first deployment, refreshes the lists and redirects to it', async () => {
    await createProject(t.db, 'shop', ada.id)
    const digest = await nextErrorDigest(() =>
      createServiceAction(
        'shop',
        NO_STATE,
        form({ name: ' api ', repo: ' acme/api ', branch: '', rootDirectory: '', healthcheckPath: ' /up ', port: '', memoryLimitMB: '256', startCommand: '' }),
      ),
    )
    expect(redirectTarget(digest)).toBe('/projects/shop/services/api')
    expect(await serviceNames()).toEqual(['api'])
    expect(await triggers()).toEqual(['manual'])
    expect(await auditActions()).toEqual(['service.create'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/')
    const [row] = await t.sql`select source, deploy from service_instances`
    expect(row!.source).toEqual({ repo: 'acme/api', branch: 'main' })
    expect(row!.deploy).toMatchObject({ port: 8080, memoryLimitMB: 256, healthcheckPath: '/up' })
  })

  test('wrong fields come back as fieldErrors with what was typed, so the form can show it again', async () => {
    await createProject(t.db, 'shop', ada.id)
    const state = await createServiceAction(
      'shop',
      NO_STATE,
      form({ name: 'Bad Name', repo: 'acme web', branch: 'dev', port: 'abc', memoryLimitMB: '0', startCommand: 'node\na.js', unrelated: 'x' }),
    )
    expect(state).toEqual({
      fieldErrors: {
        name: expect.stringContaining('name must be'),
        repo: 'use the form owner/name',
        port: 'must be a whole number',
        memoryLimitMB: 'must be between 6 and 2048 MB',
        startCommand: 'contains invalid characters',
      },
      values: { name: 'Bad Name', repo: 'acme web', branch: 'dev', port: 'abc', memoryLimitMB: '0', startCommand: 'node\na.js' },
    })
    expect(await serviceNames()).toEqual([])
    expect(await triggers()).toEqual([])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('a name already used comes back against the name field', async () => {
    await shopWithWeb()
    const state = await createServiceAction('shop', NO_STATE, form({ name: 'web', repo: 'acme/web' }))
    expect(state).toMatchObject({ fieldErrors: { name: 'service "web" already exists in project "shop"' } })
    expect(await serviceNames()).toEqual(['web'])
  })

  test('a missing field, or a file where text belongs, counts as not given', async () => {
    await createProject(t.db, 'shop', ada.id)
    expect(await createServiceAction('shop', NO_STATE, form({}))).toMatchObject({
      fieldErrors: { name: 'name is required', repo: 'use the form owner/name' },
    })
    expect(await createServiceAction('shop', NO_STATE, form({ name: new Blob(['web']), repo: 'acme/web' }))).toMatchObject({
      fieldErrors: { name: 'name is required' },
    })
    expect(await serviceNames()).toEqual([])
  })

  test('an unexpected failure is the generic message, logged without the statement parameters', async () => {
    await createProject(t.db, 'shop', ada.id)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table domains rename to domains_away`
    try {
      expect(await createServiceAction('shop', NO_STATE, form({ name: 'web', repo: 'acme/web' }))).toEqual({
        error: GENERIC_ERROR,
        values: { name: 'web', repo: 'acme/web' },
      })
    } finally {
      await t.sql`alter table domains_away rename to domains`
    }
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('creating service')
    expect(logged).not.toContain('params')
  })
})

describe('saveServiceSettingsAction', () => {
  test('the save-deploy button saves, queues a "config" deployment and refreshes the pages', async () => {
    await shopWithWeb()
    const state = await saveServiceSettingsAction('shop', 'web', NO_STATE, form({ ...SETTINGS, port: '3000', intent: 'save-deploy' }))
    expect(state).toEqual({ notice: 'Settings saved. A deployment is queued.' })
    expect(await triggers()).toEqual(['config'])
    expect(await auditActions()).toEqual(['service.update'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/services/web')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
    const [row] = await t.sql`select deploy from service_instances`
    expect(row!.deploy).toMatchObject({ port: 3000 })
  })

  test('without a button value (Enter in a field) it is save-deploy', async () => {
    await shopWithWeb()
    await saveServiceSettingsAction('shop', 'web', NO_STATE, form({ ...SETTINGS, port: '3000' }))
    expect(await triggers()).toEqual(['config'])
  })

  test('the save-only button saves and queues nothing', async () => {
    await shopWithWeb()
    const state = await saveServiceSettingsAction('shop', 'web', NO_STATE, form({ ...SETTINGS, port: '3000', intent: 'save-only' }))
    expect(state).toEqual({ notice: 'Settings saved. They go live with the next deploy.' })
    expect(await triggers()).toEqual([])
    expect(await auditActions()).toEqual(['service.update'])
    const [row] = await t.sql`select deploy from service_instances`
    expect(row!.deploy).toMatchObject({ port: 3000 })
  })

  test('wrong values come back next to their fields with what was typed, and neither save nor queue anything', async () => {
    await shopWithWeb()
    for (const intent of ['save-deploy', 'save-only']) {
      const state = await saveServiceSettingsAction(
        'shop',
        'web',
        NO_STATE,
        form({ ...SETTINGS, port: '70000', memoryLimitMB: '0', healthcheckPath: 'x', repo: 'acme web', intent }),
      )
      expect(state).toEqual({
        fieldErrors: {
          port: 'must be between 1 and 65535',
          memoryLimitMB: 'must be between 6 and 2048 MB',
          healthcheckPath: 'must start with /',
          repo: 'use the form owner/name',
        },
        values: { ...SETTINGS, port: '70000', memoryLimitMB: '0', healthcheckPath: 'x', repo: 'acme web' },
      })
    }
    expect(await triggers()).toEqual([])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
    const [row] = await t.sql`select source, deploy from service_instances`
    expect(row!.source).toEqual({ repo: 'acme/web', branch: 'main' })
    expect(row!.deploy).toMatchObject({ port: 8080, memoryLimitMB: 512 })
  })

  test('a service that does not exist is the 404 page', async () => {
    await shopWithWeb()
    expect(await nextErrorDigest(() => saveServiceSettingsAction('shop', 'nothing', NO_STATE, form(SETTINGS)))).toBe(NOT_FOUND_DIGEST)
  })

  test('an unexpected failure is the generic message', async () => {
    await shopWithWeb()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table deployments rename to deployments_away`
    try {
      expect(await saveServiceSettingsAction('shop', 'web', NO_STATE, form({ ...SETTINGS, port: '3000' }))).toEqual({
        error: GENERIC_ERROR,
        values: { ...SETTINGS, port: '3000' },
      })
    } finally {
      await t.sql`alter table deployments_away rename to deployments`
    }
    expect(String(log.mock.calls[0]![0])).toContain('saving service settings')
  })
})

describe('deleteServiceAction', () => {
  test('with the name typed it deletes, refreshes the lists and goes back to the project', async () => {
    await shopWithWeb()
    const digest = await nextErrorDigest(() => deleteServiceAction('shop', 'web', NO_STATE, form({ confirm: ' web ' })))
    expect(redirectTarget(digest)).toBe('/projects/shop')
    expect(await serviceNames()).toEqual([])
    expect(await auditActions()).toEqual(['service.delete'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/')
  })

  test('with another name, or none, it stays and says to type the name', async () => {
    await shopWithWeb()
    const attemptsWith: Record<string, string | Blob>[] = [{ confirm: 'web2' }, {}, { confirm: new Blob(['web']) }, { confirm: 'shop' }]
    for (const fields of attemptsWith) {
      expect(await deleteServiceAction('shop', 'web', NO_STATE, form(fields))).toEqual({ error: 'type the service name to confirm' })
    }
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditActions()).toEqual([])
  })

  test('while a deployment is building it is refused with the reason', async () => {
    const { instance } = await shopWithWeb()
    const queued = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    await claimNextDeployment(t.db)
    await setDeploymentStatus(t.db, queued.id, 'BUILDING')
    expect(await deleteServiceAction('shop', 'web', NO_STATE, form({ confirm: 'web' }))).toEqual({
      error: 'wait for the running deployment to finish',
    })
    expect(await serviceNames()).toEqual(['web'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})
