import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { authenticate, createSession, createUser, resolveSession, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import type { SessionCookieOptions } from '@/server/session'

// See admin-action-wrappers.test.ts: Next's request scope is replaced, the rest is the real code.
const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  origin: 'https://panel.example.com' as string | null,
  ip: '203.0.113.7',
  user: undefined as unknown,
  order: [] as string[],
  cookieWrites: [] as { name: string; value: string; options: SessionCookieOptions }[],
  revalidatePath: vi.fn<(path: string) => void>(),
}))

vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({ 'x-forwarded-for': mocks.ip, ...(mocks.origin === null ? {} : { origin: mocks.origin }) }),
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: SessionCookieOptions) => void mocks.cookieWrites.push({ name, value, options }),
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/server/config', () => ({ webConfig: () => ({ panelOrigin: 'https://panel.example.com' }) }))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))
vi.mock('@/server/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/session')>()),
  resolveSessionUser: async () => {
    mocks.order.push('session')
    return mocks.user
  },
}))

import { changeOwnPasswordAction } from '@/server/actions/account'
import { CURRENT_PASSWORD_INCORRECT } from '@/server/account'
import { GENERIC_ERROR } from '@/server/errors'
import { ForbiddenError } from '@/server/origin'
import { SESSION_COOKIE } from '@/server/session'
import { nextErrorDigest, PASSWORD, redirectTarget } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})

let ada: SafeUser
beforeEach(async () => {
  await t.reset()
  // The login limits of the process are shared by every test file's module graph; start each test clean.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('vpsm.web.loginLimits')]
  ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
  mocks.user = ada
  mocks.origin = 'https://panel.example.com'
  mocks.ip = '203.0.113.7'
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
const NEW_PASSWORD = 'a brand new passphrase'
const good = (extra: Record<string, string | Blob> = {}) =>
  form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, ...extra })

const auditActions = async () => (await t.sql`select action from audit_events order by id`).map((row) => row.action)

describe('changeOwnPasswordAction', () => {
  test('refuses a missing, foreign or lookalike Origin before reading the session', async () => {
    for (const origin of [null, 'https://evil.example.com', 'https://panel.example.com/', 'http://panel.example.com', 'null']) {
      mocks.origin = origin
      await expect(changeOwnPasswordAction(NO_STATE, good())).rejects.toBeInstanceOf(ForbiddenError)
    }
    expect(mocks.order).toEqual([])
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(mocks.cookieWrites).toEqual([])
  })

  test('sends someone who is not signed in to /login and does nothing', async () => {
    mocks.user = null
    expect(redirectTarget(await nextErrorDigest(() => changeOwnPasswordAction(NO_STATE, good())))).toBe('/login')
    expect(mocks.order).toEqual(['session'])
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(await auditActions()).toEqual([])
  })

  test('works for a member as for an admin (it is not an admin action)', async () => {
    expect(await changeOwnPasswordAction(NO_STATE, good())).toHaveProperty('notice')
  })

  test('changes the password, ends the other sessions and sets the cookie of a new session', async () => {
    const old = await createSession(t.db, ada.id)
    const state = await changeOwnPasswordAction(NO_STATE, good())
    expect(state).toEqual({ notice: 'Password changed. You were signed out everywhere else.' })

    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', NEW_PASSWORD)).not.toBeNull()
    expect(await resolveSession(t.db, old.token)).toBeNull()

    expect(mocks.cookieWrites).toHaveLength(1)
    const { name, value, options } = mocks.cookieWrites[0]!
    expect(name).toBe(SESSION_COOKIE)
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    expect((await resolveSession(t.db, value))?.user.id).toBe(ada.id)

    expect(await auditActions()).toEqual(['user.change_password'])
    expect(JSON.stringify(await t.sql`select * from audit_events`)).not.toContain(NEW_PASSWORD)
    expect(JSON.stringify(state)).not.toContain(NEW_PASSWORD)
  })

  test('a wrong current password is refused without a new cookie, and nothing changes', async () => {
    const state = await changeOwnPasswordAction(NO_STATE, good({ currentPassword: 'not the password!!' }))
    expect(state).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(mocks.cookieWrites).toEqual([])
    expect(await auditActions()).toEqual([])
  })

  test('a refused new password comes back with its reason and never echoes what was typed', async () => {
    const state = await changeOwnPasswordAction(NO_STATE, good({ newPassword: 'short', confirmPassword: 'short' }))
    expect(state).toEqual({ fieldErrors: { newPassword: 'password must be at least 12 characters' } })
    expect(await changeOwnPasswordAction(NO_STATE, good({ confirmPassword: 'something else entirely' }))).toEqual({
      fieldErrors: { confirmPassword: 'passwords do not match' },
    })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(mocks.cookieWrites).toEqual([])
  })

  test('the login throttle applies: after 10 wrong current passwords even the right one is refused', async () => {
    for (let n = 0; n < 10; n++) {
      expect(await changeOwnPasswordAction(NO_STATE, good({ currentPassword: 'not the password!!' }))).toEqual({
        error: CURRENT_PASSWORD_INCORRECT,
      })
    }
    expect(await changeOwnPasswordAction(NO_STATE, good())).toEqual({ error: 'too many attempts, try again later' })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(mocks.cookieWrites).toEqual([])

    // Keyed by IP and email: the same user from another address is not locked out.
    mocks.ip = '198.51.100.9'
    expect(await changeOwnPasswordAction(NO_STATE, good())).toHaveProperty('notice')
  })

  test('an unexpected failure is the generic message, logged without the passwords', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table users rename to users_away`
    try {
      expect(await changeOwnPasswordAction(NO_STATE, good())).toEqual({ error: GENERIC_ERROR })
    } finally {
      await t.sql`alter table users_away rename to users`
    }
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('changing password')
    expect(logged).not.toContain(PASSWORD)
    expect(logged).not.toContain(NEW_PASSWORD)
    expect(mocks.cookieWrites).toEqual([])
  })
})
