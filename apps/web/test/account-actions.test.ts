import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { authenticate, createSession, createUser, resolveSession, setUserDisabled, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import {
  CURRENT_PASSWORD_INCORRECT,
  doChangeOwnPassword,
  PASSWORD_CHANGED_SIGN_IN,
  PASSWORD_MUST_DIFFER,
  PASSWORDS_DO_NOT_MATCH,
} from '@/server/account'
import { attemptLogin, LOGIN_FAILED, LOGIN_THROTTLED } from '@/server/auth'
import { createLoginLimits, type LoginLimits } from '@/server/rate-limit'
import { PASSWORD } from './helpers'

// createSession is wrapped, not replaced, so that one test can make it fail.
vi.mock('@vpsm/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vpsm/db')>()
  return { ...original, createSession: vi.fn(original.createSession) }
})

let t: Awaited<ReturnType<typeof setupTestDb>>
let limits: LoginLimits
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
})

let ada: SafeUser
beforeEach(async () => {
  await t.reset()
  limits = createLoginLimits()
  ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
})

const NEW_PASSWORD = 'a brand new passphrase'
const IP = '203.0.113.7'

type Fields = { currentPassword?: string; newPassword?: string; confirmPassword?: string }
const change = (fields: Fields, user: SafeUser = ada, ip = IP) =>
  doChangeOwnPassword({ db: t.db, limits, headers: new Headers({ 'x-forwarded-for': ip }) }, user, {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
    ...fields,
  })

const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`

describe('doChangeOwnPassword', () => {
  test('with the right current password it sets the new one, ends every session and opens a fresh one', async () => {
    const first = await createSession(t.db, ada.id)
    const second = await createSession(t.db, ada.id)

    const result = await change({})
    if (!('session' in result)) throw new Error(`expected a session, got ${JSON.stringify(result)}`)

    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', NEW_PASSWORD)).toMatchObject({ id: ada.id })
    expect(await resolveSession(t.db, first.token)).toBeNull()
    expect(await resolveSession(t.db, second.token)).toBeNull()
    expect((await resolveSession(t.db, result.session.token))?.user.id).toBe(ada.id)
    expect(result.session.expiresAt).toBeInstanceOf(Date)
    expect(await t.sql`select 1 from sessions`).toHaveLength(1)
  })

  test('records user.change_password for the user, with no metadata and no password anywhere', async () => {
    await change({})
    const rows = await auditRows()
    expect(rows).toEqual([
      { actor_id: ada.id, action: 'user.change_password', target_type: 'user', target_id: ada.id, metadata: null },
    ])
    expect(JSON.stringify(rows)).not.toContain(PASSWORD)
    expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD)
  })

  test('a wrong current password is refused with its own message and changes nothing', async () => {
    const { token } = await createSession(t.db, ada.id)
    expect(await change({ currentPassword: 'not the password!!' })).toEqual({ error: 'current password is incorrect' })
    expect(CURRENT_PASSWORD_INCORRECT).toBe('current password is incorrect')
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', NEW_PASSWORD)).toBeNull()
    expect(await resolveSession(t.db, token)).not.toBeNull()
    expect(await auditRows()).toEqual([])
  })

  test.each([
    ['empty', ''],
    ['too long to be any password', 'x'.repeat(2000)],
    ['full of control characters', `${PASSWORD}\u0007`],
  ])('a current password that is %s is simply incorrect', async (_what, currentPassword) => {
    expect(await change({ currentPassword })).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
  })

  test('fields that were not submitted, or are not text, count as empty', async () => {
    const deps = { db: t.db, limits, headers: new Headers() }
    expect(await doChangeOwnPassword(deps, ada, {})).toEqual({
      fieldErrors: { newPassword: 'password must be at least 12 characters' },
    })
    expect(
      await doChangeOwnPassword(deps, ada, { currentPassword: undefined, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    ).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
  })

  test.each<[string, Fields, Record<string, string>]>([
    ['too short', { newPassword: 'short', confirmPassword: 'short' }, { newPassword: 'password must be at least 12 characters' }],
    ['one character short', { newPassword: 'x'.repeat(11), confirmPassword: 'x'.repeat(11) }, { newPassword: 'password must be at least 12 characters' }],
    [
      'too long',
      { newPassword: 'x'.repeat(1025), confirmPassword: 'x'.repeat(1025) },
      { newPassword: 'password must be at most 1024 characters' },
    ],
    [
      'full of control characters',
      { newPassword: `${NEW_PASSWORD}\n`, confirmPassword: `${NEW_PASSWORD}\n` },
      { newPassword: 'password contains invalid characters' },
    ],
    ['not repeated the same', { confirmPassword: `${NEW_PASSWORD}!` }, { confirmPassword: PASSWORDS_DO_NOT_MATCH }],
    ['not repeated at all', { confirmPassword: '' }, { confirmPassword: 'passwords do not match' }],
  ])('a new password that is %s is refused next to the field and changes nothing', async (_what, fields, fieldErrors) => {
    expect(await change(fields)).toEqual({ fieldErrors })
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(await auditRows()).toEqual([])
  })

  test('the exact limits of 12 and 1024 characters are accepted', async () => {
    const shortest = 'x'.repeat(12)
    expect(await change({ newPassword: shortest, confirmPassword: shortest })).toHaveProperty('session')
    const longest = 'y'.repeat(1024)
    expect(await change({ currentPassword: shortest, newPassword: longest, confirmPassword: longest })).toHaveProperty('session')
    expect(await authenticate(t.db, 'ada@example.com', longest)).not.toBeNull()
  })

  test('the new password must differ from the current one', async () => {
    expect(await change({ newPassword: PASSWORD, confirmPassword: PASSWORD })).toEqual({
      fieldErrors: { newPassword: 'new password must be different from the current one' },
    })
    expect(PASSWORD_MUST_DIFFER).toBe('new password must be different from the current one')
    expect(await auditRows()).toEqual([])
  })

  test('"must differ" is not an oracle for the current password: it is only said once the current one was right', async () => {
    const guess = 'a wrong guess at it'
    expect(await change({ currentPassword: guess, newPassword: guess, confirmPassword: guess })).toEqual({
      error: CURRENT_PASSWORD_INCORRECT,
    })
  })

  test('a password is used as typed: spaces at either end count', async () => {
    const padded = `  ${NEW_PASSWORD}  `
    expect(await change({ newPassword: padded, confirmPassword: padded })).toHaveProperty('session')
    expect(await authenticate(t.db, 'ada@example.com', padded)).not.toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', NEW_PASSWORD)).toBeNull()
  })

  describe('throttling', () => {
    test('after 10 wrong current passwords the 11th attempt is refused, even with the right one', async () => {
      for (let n = 0; n < 10; n++) {
        expect(await change({ currentPassword: 'not the password!!' })).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
      }
      expect(await change({})).toEqual({ error: LOGIN_THROTTLED })
      expect(LOGIN_THROTTLED).toBe('too many attempts, try again later')
      expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
      expect(await auditRows()).toEqual([])

      // The key is IP + email: another address is unaffected.
      expect(await change({}, ada, '198.51.100.9')).toHaveProperty('session')
    })

    test('the counter is the one of the login form: failures there count here, and the other way round', async () => {
      const login = (password: string) => {
        const form = new FormData()
        form.set('email', 'ada@example.com')
        form.set('password', password)
        return attemptLogin({ db: t.db, limits, headers: new Headers({ 'x-forwarded-for': IP }) }, form)
      }
      for (let n = 0; n < 6; n++) expect(await login('wrong password!!')).toEqual({ error: LOGIN_FAILED })
      for (let n = 0; n < 4; n++) expect(await change({ currentPassword: 'wrong password!!' })).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
      expect(await change({})).toEqual({ error: LOGIN_THROTTLED })
      expect(await login(PASSWORD)).toEqual({ error: LOGIN_THROTTLED })
    })

    test('a successful change resets the counter of that address and email', async () => {
      for (let n = 0; n < 9; n++) await change({ currentPassword: 'wrong password!!' })
      expect(await change({})).toHaveProperty('session')
      for (let n = 0; n < 10; n++) {
        expect(await change({ currentPassword: 'wrong password!!' })).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
      }
      expect(await change({ currentPassword: 'wrong password!!' })).toEqual({ error: LOGIN_THROTTLED })
    })

    test('one address gets at most 50 failures in total, whatever the user', async () => {
      const users: SafeUser[] = []
      for (let n = 0; n < 6; n++) {
        users.push(await createUser(t.db, { email: `u${n}@example.com`, name: `U${n}`, role: 'member', password: PASSWORD }))
      }
      for (let n = 0; n < 50; n++) {
        const user = users[n % 5]!
        // Each user stays under its own 10; the address as a whole reaches 50.
        expect(await change({ currentPassword: 'wrong password!!' }, user)).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
      }
      expect(await change({}, users[5]!)).toEqual({ error: LOGIN_THROTTLED })
    })

    test('a burst of concurrent attempts gets no more than 10 guesses', async () => {
      const results = await Promise.all(Array.from({ length: 15 }, () => change({ currentPassword: 'wrong password!!' })))
      expect(results.filter((r) => 'error' in r && r.error === CURRENT_PASSWORD_INCORRECT)).toHaveLength(10)
      expect(results.filter((r) => 'error' in r && r.error === LOGIN_THROTTLED)).toHaveLength(5)
    })

    test('a refused new password does not count as a wrong guess', async () => {
      for (let n = 0; n < 20; n++) await change({ newPassword: 'short', confirmPassword: 'short' })
      expect(await change({})).toHaveProperty('session')
    })
  })

  test('if opening the new session fails the password stays changed, and the user is told to sign in', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSession).mockRejectedValueOnce(new Error('connection lost'))
    expect(await change({})).toEqual({ error: PASSWORD_CHANGED_SIGN_IN })
    expect(PASSWORD_CHANGED_SIGN_IN).toBe('password changed, but signing you in failed: sign in with the new password')
    expect(await authenticate(t.db, 'ada@example.com', NEW_PASSWORD)).not.toBeNull()
    expect(await t.sql`select 1 from sessions`).toHaveLength(0)
    expect((await auditRows()).map((row) => row.action)).toEqual(['user.change_password'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain(NEW_PASSWORD)
  })

  test('a user who was disabled in the meantime gets no password change and no session', async () => {
    await setUserDisabled(t.db, ada.id, true)
    expect(await change({})).toEqual({ error: CURRENT_PASSWORD_INCORRECT })
    expect(await t.sql`select 1 from sessions`).toHaveLength(0)
  })

  test('a failure to record the event does not undo the change', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    let result: Awaited<ReturnType<typeof change>>
    try {
      result = await change({})
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(result).toHaveProperty('session')
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain(NEW_PASSWORD)
  })
})
