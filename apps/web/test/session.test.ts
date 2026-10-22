import { NextResponse } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createSession, createUser, resolveSession, SESSION_TTL_MS, setUserDisabled } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import {
  clearSessionCookie,
  endSession,
  resolveSessionUser,
  SESSION_COOKIE,
  sessionCookieOptions,
  setSessionCookie,
} from '@/server/session'
import { MemoryCookieJar, PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

async function userWithSession(role: 'admin' | 'member' = 'member') {
  const user = await createUser(t.db, { email: `${role}@example.com`, name: 'Ada', role, password: PASSWORD })
  const { token, expiresAt } = await createSession(t.db, user.id)
  return { user, token, expiresAt, jar: new MemoryCookieJar({ [SESSION_COOKIE]: token }) }
}

describe('session cookie', () => {
  test('is a host-only __Host- cookie: HttpOnly, Secure, SameSite=Lax, Path=/, expiring with the session', () => {
    const now = Date.UTC(2026, 9, 22, 12)
    const expiresAt = new Date(now + SESSION_TTL_MS)
    expect(SESSION_COOKIE).toBe('__Host-vpsm_session')
    expect(sessionCookieOptions(expiresAt, now)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
      maxAge: SESSION_TTL_MS / 1000,
    })
    expect(sessionCookieOptions(new Date(now - 5000), now).maxAge).toBe(0)
  })

  test('serializes to the Set-Cookie header the browser needs (through Next’s cookie store)', () => {
    const response = NextResponse.next()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    setSessionCookie(response.cookies, 'tok', expiresAt)
    const header = response.headers.get('set-cookie')!
    expect(header).toMatch(/^__Host-vpsm_session=tok; /)
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=lax']) expect(header).toContain(attribute)
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1])
    expect(maxAge).toBeGreaterThan(SESSION_TTL_MS / 1000 - 10)
    expect(maxAge).toBeLessThanOrEqual(SESSION_TTL_MS / 1000)
    // Next recomputes Expires from the (whole-second) Max-Age, so the cookie may end a moment before the session,
    // never after it.
    const expires = Date.parse(/Expires=([^;]+)/.exec(header)![1]!)
    expect(expires).toBeLessThanOrEqual(expiresAt.getTime())
    expect(expires).toBeGreaterThan(expiresAt.getTime() - 3000)
    expect(header).not.toMatch(/domain/i)
  })

  test('clearing it keeps Secure and Path=/, without which a browser ignores the deletion of a __Host- cookie', () => {
    const jar = new MemoryCookieJar({ [SESSION_COOKIE]: 'tok' })
    clearSessionCookie(jar)
    expect(jar.writes).toEqual([
      {
        name: SESSION_COOKIE,
        value: '',
        options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: new Date(0), maxAge: 0 },
      },
    ])
  })
})

describe('resolveSessionUser', () => {
  test('returns the signed-in user without the password hash and leaves a fresh cookie alone', async () => {
    const { user, jar } = await userWithSession()
    const resolved = await resolveSessionUser(t.db, jar)
    expect(resolved).toEqual(user)
    expect(resolved).not.toHaveProperty('passwordHash')
    expect(jar.writes).toEqual([])
  })

  test('returns null without a cookie, for an unknown token and for an expired session', async () => {
    expect(await resolveSessionUser(t.db, new MemoryCookieJar())).toBeNull()
    expect(await resolveSessionUser(t.db, new MemoryCookieJar({ [SESSION_COOKIE]: '' }))).toBeNull()
    expect(await resolveSessionUser(t.db, new MemoryCookieJar({ [SESSION_COOKIE]: 'not-a-session' }))).toBeNull()

    const { jar } = await userWithSession()
    await t.sql`update sessions set expires_at = now() - interval '1 second'`
    expect(await resolveSessionUser(t.db, jar)).toBeNull()
    expect(jar.writes).toEqual([])
  })

  test('currentUser rejects a disabled user with a live session', async () => {
    const { user, jar } = await userWithSession()
    // Disabled behind the app's back: the session row is still there and unexpired.
    await t.sql`update users set disabled_at = now() where id = ${user.id}`
    expect(await t.sql`select 1 from sessions`).toHaveLength(1)
    expect(await resolveSessionUser(t.db, jar)).toBeNull()
  })

  test('a user disabled through setUserDisabled is signed out on the next request', async () => {
    const { user, jar } = await userWithSession()
    expect(await resolveSessionUser(t.db, jar)).not.toBeNull()
    await setUserDisabled(t.db, user.id, true)
    expect(await resolveSessionUser(t.db, jar)).toBeNull()
  })

  test('re-sets the cookie with the new expiry when the session is renewed', async () => {
    const { token, jar } = await userWithSession()
    await t.sql`update sessions set expires_at = now() + interval '1 day'`

    const before = Date.now()
    expect(await resolveSessionUser(t.db, jar)).not.toBeNull()
    const after = Date.now()

    expect(jar.writes).toHaveLength(1)
    const [write] = jar.writes
    expect(write!.name).toBe(SESSION_COOKIE)
    expect(write!.value).toBe(token)
    expect(write!.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    const expires = write!.options.expires.getTime()
    expect(expires).toBeGreaterThanOrEqual(before + SESSION_TTL_MS)
    expect(expires).toBeLessThanOrEqual(after + SESSION_TTL_MS)
    expect((await resolveSession(t.db, token))!.expiresAt.getTime()).toBe(expires)
  })
})

describe('endSession', () => {
  test('deletes the session row and clears the cookie', async () => {
    const { token, jar } = await userWithSession()
    await endSession(t.db, jar)
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(jar.writes.at(-1)).toMatchObject({ name: SESSION_COOKIE, value: '', options: { maxAge: 0, secure: true, path: '/' } })
  })

  test('without a cookie it only clears the cookie', async () => {
    const jar = new MemoryCookieJar()
    await endSession(t.db, jar)
    expect(jar.writes).toHaveLength(1)
    expect(jar.writes[0]!.options.maxAge).toBe(0)
  })
})
