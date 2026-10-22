import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSession, createUser, resolveSession, setUserDisabled } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { attemptLogin, LOGIN_FAILED, LOGIN_THROTTLED, logout } from '@/server/auth'
import { createLoginLimits, type LoginLimits } from '@/server/rate-limit'
import { SESSION_COOKIE } from '@/server/session'
import { MemoryCookieJar, PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
let limits: LoginLimits
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
  limits = createLoginLimits()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

const IP = '203.0.113.7'
const login = (email: string, password: string, ip = IP) =>
  attemptLogin({ db: t.db, limits, headers: new Headers({ 'x-forwarded-for': ip }) }, form({ email, password }))

const ada = () => createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`

describe('attemptLogin', () => {
  test('returns a session for the right password (email case and spaces do not matter)', async () => {
    const user = await ada()
    const result = await login('  ADA@example.com ', PASSWORD)
    if (!('session' in result)) throw new Error(`expected a session, got ${JSON.stringify(result)}`)
    expect((await resolveSession(t.db, result.session.token))?.user.id).toBe(user.id)
    expect(result.session.expiresAt).toBeInstanceOf(Date)
  })

  test('every failure gives the same message, whether or not the email exists', async () => {
    const user = await ada()
    await createUser(t.db, { email: 'root@example.com', name: 'Root', role: 'admin', password: PASSWORD })
    const failures = [
      await login('ada@example.com', 'wrong password!!'),
      await login('nobody@example.com', PASSWORD),
      await login('', ''),
      await login('ada@example.com', ''),
      await login(`${'a'.repeat(400)}@example.com`, PASSWORD),
      await login('ada@example.com', 'x'.repeat(2000)),
      await attemptLogin(
        { db: t.db, limits, headers: new Headers() },
        form({ email: new Blob(['ada@example.com']), password: PASSWORD }),
      ),
    ]
    await setUserDisabled(t.db, user.id, true)
    failures.push(await login('ada@example.com', PASSWORD))
    for (const failure of failures) expect(failure).toEqual({ error: LOGIN_FAILED })
    expect(LOGIN_FAILED).toBe('invalid email or password')
  })

  test('after 10 failures the 11th attempt is refused, even with the right password', async () => {
    await ada()
    for (let n = 0; n < 10; n++) expect(await login('ada@example.com', 'wrong password!!')).toEqual({ error: LOGIN_FAILED })
    expect(await login('ada@example.com', PASSWORD)).toEqual({ error: LOGIN_THROTTLED })
    expect(LOGIN_THROTTLED).toBe('too many attempts, try again later')

    // The key is IP + email: another address, or the same address for another email, is unaffected.
    expect(await login('ada@example.com', PASSWORD, '198.51.100.9')).toHaveProperty('session')
    expect(await login('other@example.com', PASSWORD)).toEqual({ error: LOGIN_FAILED })
  })

  test('a successful login resets the counter', async () => {
    await ada()
    for (let n = 0; n < 9; n++) await login('ada@example.com', 'wrong password!!')
    expect(await login('ada@example.com', PASSWORD)).toHaveProperty('session')
    for (let n = 0; n < 10; n++) expect(await login('ada@example.com', 'wrong password!!')).toEqual({ error: LOGIN_FAILED })
    expect(await login('ada@example.com', 'wrong password!!')).toEqual({ error: LOGIN_THROTTLED })
  })

  test('a burst of concurrent attempts gets no more than 10 guesses', async () => {
    await ada()
    const results = await Promise.all(Array.from({ length: 15 }, () => login('ada@example.com', 'wrong password!!')))
    expect(results.filter((r) => 'error' in r && r.error === LOGIN_FAILED)).toHaveLength(10)
    expect(results.filter((r) => 'error' in r && r.error === LOGIN_THROTTLED)).toHaveLength(5)
  })

  test('one IP gets at most 50 failures in total, whatever the emails', async () => {
    await ada()
    for (let n = 0; n < 45; n++) expect(await login(`junk-${n}`, 'x')).toEqual({ error: LOGIN_FAILED })
    for (let n = 0; n < 5; n++) expect(await login(`nobody-${n}@example.com`, 'wrong password!!')).toEqual({ error: LOGIN_FAILED })

    expect(await login('fresh@example.com', 'wrong password!!')).toEqual({ error: LOGIN_THROTTLED })
    expect(await login('ada@example.com', PASSWORD)).toEqual({ error: LOGIN_THROTTLED })
    expect(await login('ada@example.com', PASSWORD, '198.51.100.9')).toHaveProperty('session')
  })

  test('input no account can match fails at once, without a per-email key (it still counts for the IP)', async () => {
    await ada()
    for (const [email, password] of [
      ['ada.example.com', PASSWORD], // no @
      ['   ', PASSWORD],
      ['ada@example.com\u0000', PASSWORD],
      ['ada@exa\nmple.com', PASSWORD],
      ['ada@example.com', `${PASSWORD}\u0007`],
      ['ada@example.com', 'x'.repeat(1025)],
      [`${'a'.repeat(400)}@example.com`, PASSWORD],
    ] as const) {
      expect(await login(email, password), JSON.stringify(email)).toEqual({ error: LOGIN_FAILED })
    }
    expect(limits.perEmail.size()).toBe(0)
    expect(limits.perIp.size()).toBe(1)
  })

  test('flooding the per-email limiter with junk keys does not unblock a victim', async () => {
    limits = createLoginLimits({ maxKeys: 15 })
    await ada()
    for (let n = 0; n < 10; n++) await login('ada@example.com', 'wrong password!!')
    const junk = []
    for (let n = 0; n < 39; n++) junk.push(await login(`junk-${n}@example.com`, 'wrong password!!'))
    // 14 junk keys fit beside the victim's; after that new keys are refused, not recorded.
    expect(junk.filter((r) => 'error' in r && r.error === LOGIN_FAILED)).toHaveLength(14)
    expect(junk.filter((r) => 'error' in r && r.error === LOGIN_THROTTLED)).toHaveLength(25)
    expect(limits.perEmail.size()).toBe(15)
    expect(await login('ada@example.com', PASSWORD)).toEqual({ error: LOGIN_THROTTLED })
  })

  test('records auth.login with the IP for a successful login, nothing for failures', async () => {
    const user = await ada()
    await login('ada@example.com', 'wrong password!!')
    await login('nobody@example.com', PASSWORD)
    expect(await auditRows()).toEqual([])

    await login('ada@example.com', PASSWORD)
    expect(await auditRows()).toEqual([
      { actor_id: user.id, action: 'auth.login', target_type: 'user', target_id: user.id, metadata: { ip: IP } },
    ])
  })

  test('a failure to record the audit event does not stop the login', async () => {
    await ada()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      expect(await login('ada@example.com', PASSWORD)).toHaveProperty('session')
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('auth.login')
    expect(logged).not.toContain(PASSWORD)
  })
})

describe('logout', () => {
  test('ends the session, clears the cookie and records auth.logout for its user', async () => {
    const user = await ada()
    const { token } = await createSession(t.db, user.id)
    const jar = new MemoryCookieJar({ [SESSION_COOKIE]: token })
    await logout(t.db, jar)
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(jar.writes.at(-1)).toMatchObject({ name: SESSION_COOKIE, value: '', options: { maxAge: 0 } })
    expect(await auditRows()).toEqual([
      { actor_id: user.id, action: 'auth.logout', target_type: 'user', target_id: user.id, metadata: null },
    ])
  })

  test('records nothing when there is no session to end', async () => {
    await logout(t.db, new MemoryCookieJar())
    await logout(t.db, new MemoryCookieJar({ [SESSION_COOKIE]: 'not-a-session' }))
    expect(await auditRows()).toEqual([])
  })

  test('a failure to record the audit event does not stop the logout', async () => {
    const user = await ada()
    const { token } = await createSession(t.db, user.id)
    const jar = new MemoryCookieJar({ [SESSION_COOKIE]: token })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      await logout(t.db, jar)
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(jar.writes.at(-1)).toMatchObject({ value: '', options: { maxAge: 0 } })
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain(token)
  })
})
