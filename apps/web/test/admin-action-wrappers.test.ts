import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { authenticate, createUser, getResourceSettings, setUserDisabled, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import type { SessionCookieOptions } from '@/server/session'

// The server action wrappers need Next's request scope (headers, the session cookie, the cache), which does not
// exist in a unit test: those are replaced here, and the rest (origin check, session and admin guards, parsing,
// audit, redirect()/notFound(), the generic error) is the real code.
const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  origin: 'https://panel.example.com' as string | null,
  user: undefined as unknown,
  order: [] as string[],
  cookieWrites: [] as { name: string; value: string; options: SessionCookieOptions }[],
  revalidatePath: vi.fn<(path: string) => void>(),
}))

vi.mock('next/headers', () => ({
  headers: async () => new Headers(mocks.origin === null ? {} : { origin: mocks.origin }),
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: SessionCookieOptions) => void mocks.cookieWrites.push({ name, value, options }),
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/server/config', () => ({ webConfig: () => ({ panelOrigin: 'https://panel.example.com' }) }))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))
// The session lookup is the one thing under the real guards that is replaced: `order` shows whether it ran.
vi.mock('@/server/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/session')>()),
  resolveSessionUser: async () => {
    mocks.order.push('session')
    return mocks.user
  },
}))

import {
  createUserAction,
  resetPasswordAction,
  saveResourceSettingsAction,
  setDisabledAction,
  setRoleAction,
} from '@/server/actions/admin'
import { GENERIC_ERROR } from '@/server/errors'
import { ForbiddenError } from '@/server/origin'
import { SESSION_COOKIE } from '@/server/session'
import { nextErrorDigest, NOT_FOUND_DIGEST, PASSWORD, redirectTarget } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})

let root: SafeUser
let other: SafeUser
let ada: SafeUser
beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  root = await make('root@example.com', 'Root', 'admin')
  other = await make('other@example.com', 'Other', 'admin')
  ada = await make('ada@example.com', 'Ada', 'member')
  mocks.user = root
  mocks.origin = 'https://panel.example.com'
  mocks.order.length = 0
  mocks.cookieWrites.length = 0
  mocks.revalidatePath.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}
const NO_STATE = {}

const auditActions = async () => (await t.sql`select action from audit_events order by id`).map((row) => row.action)
const userCount = async () => (await t.sql`select 1 from users`).length
const roleOf = async (id: string) => (await t.sql`select role from users where id = ${id}`)[0]!.role
const isDisabled = async (id: string) => (await t.sql`select disabled_at from users where id = ${id}`)[0]!.disabled_at !== null

const attempts: [string, () => Promise<unknown>][] = [
  ['createUserAction', () => createUserAction(NO_STATE, form({ email: 'new@example.com', name: 'New', role: 'admin' }))],
  ['resetPasswordAction', () => resetPasswordAction(ada.id, NO_STATE, form({}))],
  ['setRoleAction', () => setRoleAction(ada.id, 'admin', NO_STATE, form({}))],
  ['setDisabledAction', () => setDisabledAction(ada.id, true, NO_STATE, form({}))],
  [
    'saveResourceSettingsAction',
    () => saveResourceSettingsAction(NO_STATE, form({ memoryBudgetMb: '4096', maxServiceMemoryMb: '1024' })),
  ],
]

async function expectNothingChanged() {
  expect(await userCount()).toBe(3)
  expect(await roleOf(ada.id)).toBe('member')
  expect(await isDisabled(ada.id)).toBe(false)
  expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
  expect(await getResourceSettings(t.db)).toEqual({})
  expect(await auditActions()).toEqual([])
  expect(mocks.revalidatePath).not.toHaveBeenCalled()
  expect(mocks.cookieWrites).toEqual([])
}

describe('every admin action starts with the same-origin check, then the session, then the admin check', () => {
  test.each(attempts)('%s refuses a missing, foreign or lookalike Origin before reading the session', async (_name, run) => {
    for (const origin of [null, 'https://evil.example.com', 'https://panel.example.com/', 'http://panel.example.com', 'null']) {
      mocks.origin = origin
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError)
    }
    expect(mocks.order).toEqual([])
    await expectNothingChanged()
  })

  test.each(attempts)('%s sends someone who is not signed in to /login and does nothing', async (_name, run) => {
    mocks.user = null
    expect(redirectTarget(await nextErrorDigest(run))).toBe('/login')
    expect(mocks.order).toEqual(['session'])
    await expectNothingChanged()
  })

  test.each(attempts)('%s is a plain 404 for a member, who changes nothing', async (_name, run) => {
    mocks.user = ada
    expect(await nextErrorDigest(run)).toBe(NOT_FOUND_DIGEST)
    expect(mocks.order).toEqual(['session'])
    await expectNothingChanged()
  })

  test('a member gets the 404 whatever the target is, even themselves or a user that does not exist', async () => {
    mocks.user = ada
    for (const run of [
      () => setRoleAction(ada.id, 'admin', NO_STATE, form({})),
      () => setDisabledAction('00000000-0000-4000-8000-000000000000', true, NO_STATE, form({})),
      () => resetPasswordAction('not-a-uuid', NO_STATE, form({})),
    ]) {
      expect(await nextErrorDigest(run)).toBe(NOT_FOUND_DIGEST)
    }
    await expectNothingChanged()
  })
})

describe('createUserAction', () => {
  test('creates the user and hands the generated password back once, in the result and nowhere else', async () => {
    const log = vi.spyOn(console, 'error')
    const state = await createUserAction(NO_STATE, form({ email: ' New@Example.com ', name: ' New ', role: 'admin' }))
    expect(state).toEqual({ issued: { email: 'new@example.com', password: expect.stringMatching(/^[A-Za-z0-9]{20}$/) } })
    const password = state.issued!.password

    expect(await authenticate(t.db, 'new@example.com', password)).toMatchObject({ name: 'New', role: 'admin' })
    expect(await auditActions()).toEqual(['user.create'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/users')

    const everythingStored = JSON.stringify({
      audit: await t.sql`select * from audit_events`,
      users: await t.sql`select * from users`,
      settings: await t.sql`select * from settings`,
    })
    expect(everythingStored).not.toContain(password)
    expect(log).not.toHaveBeenCalled()
  })

  test('without a role the user is a member', async () => {
    const state = await createUserAction(NO_STATE, form({ email: 'new@example.com', name: 'New' }))
    expect(state.issued).toBeDefined()
    expect(await roleOf((await t.sql`select id from users where email = 'new@example.com'`)[0]!.id)).toBe('member')
  })

  test('a refused form comes back with the reasons and what was typed, but no password', async () => {
    const state = await createUserAction(NO_STATE, form({ email: ' ADA@example.com ', name: 'Another Ada', role: 'owner' }))
    expect(state).toEqual({
      fieldErrors: { role: 'role must be "admin" or "member"' },
      values: { email: 'ADA@example.com', name: 'Another Ada', role: 'owner' },
    })
    const taken = await createUserAction(NO_STATE, form({ email: 'ada@example.com', name: 'Another Ada' }))
    expect(taken).toEqual({
      fieldErrors: { email: 'a user with this email already exists' },
      values: { email: 'ada@example.com', name: 'Another Ada' },
    })
    expect(await userCount()).toBe(3)
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('a field that is a file upload counts as missing', async () => {
    expect(await createUserAction(NO_STATE, form({ email: new Blob(['new@example.com']), name: 'New' }))).toMatchObject({
      fieldErrors: { email: 'email is required' },
    })
  })

  test('an unexpected failure is the generic message, logged without the statement parameters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table users rename to users_away`
    let state
    try {
      state = await createUserAction(NO_STATE, form({ email: 'new@example.com', name: 'New' }))
    } finally {
      await t.sql`alter table users_away rename to users`
    }
    expect(state).toEqual({ error: GENERIC_ERROR, values: { email: 'new@example.com', name: 'New' } })
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('creating user')
    expect(logged).not.toContain('params')
  })
})

describe('resetPasswordAction', () => {
  test('sets a generated password for the user, hands it back once and records user.reset_password', async () => {
    const state = await resetPasswordAction(ada.id, NO_STATE, form({}))
    expect(state).toEqual({ issued: { email: 'ada@example.com', password: expect.stringMatching(/^[A-Za-z0-9]{20}$/) } })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', state.issued!.password)).not.toBeNull()
    expect(await auditActions()).toEqual(['user.reset_password'])
    expect(JSON.stringify(await t.sql`select * from audit_events`)).not.toContain(state.issued!.password)
    expect(mocks.cookieWrites).toEqual([])
  })

  test('a user that does not exist is "user not found"', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', '']) {
      expect(await resetPasswordAction(id, NO_STATE, form({}))).toEqual({ error: 'user not found' })
    }
    expect(await auditActions()).toEqual([])
  })

  test('an admin resetting their own password ends their sessions: the cookie is cleared and they go to /login', async () => {
    const digest = await nextErrorDigest(() => resetPasswordAction(root.id, NO_STATE, form({})))
    expect(redirectTarget(digest)).toBe('/login')
    expect(await authenticate(t.db, 'root@example.com', PASSWORD)).toBeNull()
    expect(await auditActions()).toEqual(['user.reset_password'])
    expect(mocks.cookieWrites).toEqual([{ name: SESSION_COOKIE, value: '', options: expect.objectContaining({ maxAge: 0 }) }])
  })

  test('an unexpected failure is the generic message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table users rename to users_away`
    try {
      expect(await resetPasswordAction(ada.id, NO_STATE, form({}))).toEqual({ error: GENERIC_ERROR })
    } finally {
      await t.sql`alter table users_away rename to users`
    }
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('setRoleAction', () => {
  test('changes the role and refreshes the user list', async () => {
    expect(await setRoleAction(ada.id, 'admin', NO_STATE, form({}))).toEqual({})
    expect(await roleOf(ada.id)).toBe('admin')
    expect(await auditActions()).toEqual(['user.set_role'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/users')
  })

  test('the last active admin cannot be demoted: the message of the rule, and nothing changes', async () => {
    await setUserDisabled(t.db, other.id, true)
    expect(await setRoleAction(root.id, 'member', NO_STATE, form({}))).toEqual({ error: 'at least one active admin is required' })
    expect(await roleOf(root.id)).toBe('admin')
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('an admin who demotes themselves, with another active admin around, is sent to the project list', async () => {
    const digest = await nextErrorDigest(() => setRoleAction(root.id, 'member', NO_STATE, form({})))
    expect(redirectTarget(digest)).toBe('/')
    expect(await roleOf(root.id)).toBe('member')
    expect(await auditActions()).toEqual(['user.set_role'])
    // Their session lives on, as a member's.
    expect(mocks.cookieWrites).toEqual([])
  })

  test('an unknown role or user is refused', async () => {
    expect(await setRoleAction(ada.id, 'owner', NO_STATE, form({}))).toEqual({ error: 'role must be "admin" or "member"' })
    expect(await setRoleAction('00000000-0000-4000-8000-000000000000', 'admin', NO_STATE, form({}))).toEqual({
      error: 'user not found',
    })
    expect(await auditActions()).toEqual([])
  })
})

describe('setDisabledAction', () => {
  test('disables and enables a user and refreshes the user list', async () => {
    expect(await setDisabledAction(ada.id, true, NO_STATE, form({}))).toEqual({})
    expect(await isDisabled(ada.id)).toBe(true)
    expect(await setDisabledAction(ada.id, false, NO_STATE, form({}))).toEqual({})
    expect(await isDisabled(ada.id)).toBe(false)
    expect(await auditActions()).toEqual(['user.disable', 'user.enable'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/users')
  })

  test('the last active admin cannot be disabled: the message of the rule, and nothing changes', async () => {
    await setUserDisabled(t.db, other.id, true)
    expect(await setDisabledAction(root.id, true, NO_STATE, form({}))).toEqual({ error: 'at least one active admin is required' })
    expect(await isDisabled(root.id)).toBe(false)
    expect(await auditActions()).toEqual([])
    expect(mocks.cookieWrites).toEqual([])
  })

  test('an admin who disables themselves, with another active admin around, is signed out and sent to /login', async () => {
    const digest = await nextErrorDigest(() => setDisabledAction(root.id, true, NO_STATE, form({})))
    expect(redirectTarget(digest)).toBe('/login')
    expect(await isDisabled(root.id)).toBe(true)
    expect(await auditActions()).toEqual(['user.disable'])
    expect(mocks.cookieWrites).toEqual([{ name: SESSION_COOKIE, value: '', options: expect.objectContaining({ maxAge: 0 }) }])
  })

  test('a user that does not exist, or a value that is not true or false, is refused', async () => {
    expect(await setDisabledAction('nope', true, NO_STATE, form({}))).toEqual({ error: 'user not found' })
    expect(await setDisabledAction(ada.id, 'yes' as unknown as boolean, NO_STATE, form({}))).toEqual({
      error: 'disabled must be true or false',
    })
    expect(await auditActions()).toEqual([])
  })
})

describe('saveResourceSettingsAction', () => {
  test('saves the settings, says so and refreshes the page', async () => {
    const state = await saveResourceSettingsAction(NO_STATE, form({ memoryBudgetMb: ' 6144 ', maxServiceMemoryMb: '1024' }))
    expect(state).toEqual({ notice: 'Settings saved. They apply to the next deployment.' })
    expect(await getResourceSettings(t.db)).toEqual({ memoryBudgetMb: 6144, maxServiceMemoryMb: 1024 })
    expect(await auditActions()).toEqual(['settings.update'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/settings')
  })

  test('a value that is not a whole number comes back next to its field, with what was typed, and nothing is saved', async () => {
    const state = await saveResourceSettingsAction(NO_STATE, form({ memoryBudgetMb: '4096', maxServiceMemoryMb: '1.5GB' }))
    expect(state).toEqual({
      fieldErrors: { maxServiceMemoryMb: 'must be a whole number' },
      values: { memoryBudgetMb: '4096', maxServiceMemoryMb: '1.5GB' },
    })
    expect(await getResourceSettings(t.db)).toEqual({})
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('the message of the database check is shown as it is, and nothing is saved', async () => {
    const state = await saveResourceSettingsAction(NO_STATE, form({ memoryBudgetMb: '0', maxServiceMemoryMb: '512' }))
    expect(state).toEqual({
      error: 'memory budget must be a positive whole number of MB',
      values: { memoryBudgetMb: '0', maxServiceMemoryMb: '512' },
    })
    expect(await getResourceSettings(t.db)).toEqual({})
    expect(await auditActions()).toEqual([])
  })

  test('an unexpected failure is the generic message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table settings rename to settings_away`
    try {
      expect(await saveResourceSettingsAction(NO_STATE, form({ memoryBudgetMb: '4096', maxServiceMemoryMb: '512' }))).toEqual({
        error: GENERIC_ERROR,
        values: { memoryBudgetMb: '4096', maxServiceMemoryMb: '512' },
      })
    } finally {
      await t.sql`alter table settings_away rename to settings`
    }
    expect(log).toHaveBeenCalledTimes(1)
  })
})
