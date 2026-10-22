import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createSession, createUser, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { ensureAdmin, ensureUser } from '@/server/guards'
import { resolveSessionUser, SESSION_COOKIE } from '@/server/session'
import { MemoryCookieJar, nextErrorDigest, NOT_FOUND_DIGEST, PASSWORD, redirectTarget } from './helpers'

const someone = (role: 'admin' | 'member'): SafeUser => ({
  id: '00000000-0000-4000-8000-000000000001',
  email: `${role}@example.com`,
  name: role,
  role,
  disabledAt: null,
  createdAt: new Date(),
})

describe('ensureUser', () => {
  test('redirects to /login without a user', async () => {
    expect(redirectTarget(await nextErrorDigest(() => ensureUser(null)))).toBe('/login')
  })

  test('passes a user through', () => {
    const member = someone('member')
    expect(ensureUser(member)).toBe(member)
  })
})

describe('ensureAdmin', () => {
  test('is a plain 404 for a member, giving no hint that the page exists', async () => {
    expect(await nextErrorDigest(() => ensureAdmin(someone('member')))).toBe(NOT_FOUND_DIGEST)
  })

  test('passes an admin through', () => {
    const admin = someone('admin')
    expect(ensureAdmin(admin)).toBe(admin)
  })
})

describe('guards on real sessions', () => {
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

  async function jarFor(role: 'admin' | 'member') {
    const user = await createUser(t.db, { email: `${role}@example.com`, name: role, role, password: PASSWORD })
    const { token } = await createSession(t.db, user.id)
    return { user, jar: new MemoryCookieJar({ [SESSION_COOKIE]: token }) }
  }

  test('a member signed in is let through ensureUser but gets a 404 from ensureAdmin', async () => {
    const { user, jar } = await jarFor('member')
    const resolved = ensureUser(await resolveSessionUser(t.db, jar))
    expect(resolved.id).toBe(user.id)
    expect(await nextErrorDigest(() => ensureAdmin(resolved))).toBe(NOT_FOUND_DIGEST)
  })

  test('an admin signed in passes ensureAdmin', async () => {
    const { user, jar } = await jarFor('admin')
    expect(ensureAdmin(ensureUser(await resolveSessionUser(t.db, jar))).id).toBe(user.id)
  })

  test('a disabled user with a live session is sent to /login', async () => {
    const { user, jar } = await jarFor('member')
    await t.sql`update users set disabled_at = now() where id = ${user.id}`
    const digest = await nextErrorDigest(async () => ensureUser(await resolveSessionUser(t.db, jar)))
    expect(redirectTarget(digest)).toBe('/login')
  })
})
