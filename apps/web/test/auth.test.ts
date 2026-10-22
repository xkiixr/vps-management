import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createUser, resolveSession, setUserDisabled } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { attemptLogin, LOGIN_FAILED, LOGIN_THROTTLED } from '@/server/auth'
import { createLoginLimiter, type LoginLimiter } from '@/server/rate-limit'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
let limiter: LoginLimiter
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
  limiter = createLoginLimiter({ max: 10, windowMs: 15 * 60_000 })
})

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

const login = (email: string, password: string, ip = '203.0.113.7') =>
  attemptLogin({ db: t.db, limiter, headers: new Headers({ 'x-forwarded-for': ip }) }, form({ email, password }))

const ada = () => createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })

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
        { db: t.db, limiter, headers: new Headers() },
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
})
