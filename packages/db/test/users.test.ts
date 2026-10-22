import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import {
  authenticate,
  createSession,
  createUser,
  type Db,
  deleteSession,
  findUserByEmail,
  generatePassword,
  hashPassword,
  listUsers,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  purgeExpiredSessions,
  resolveSession,
  SESSION_RENEW_BELOW_MS,
  SESSION_TTL_MS,
  sessions,
  setPassword,
  setUserDisabled,
  setUserRole,
  users,
  ValidationError,
  verifyPassword,
} from '../src/index'
import { setupTestDb } from '../src/testing'

// Wrap (do not replace) argon2's verify so a test can observe that it ran.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const original = await importOriginal<typeof import('@node-rs/argon2')>()
  return { ...original, verify: vi.fn(original.verify) }
})
const { verify: verifySpy } = await import('@node-rs/argon2')

const t = await setupTestDb()
const { db } = t
beforeEach(async () => {
  await t.reset()
  vi.mocked(verifySpy).mockClear()
})
afterAll(() => t.close())

const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 3600_000

function makeUser(email: string, role: 'admin' | 'member' = 'member', password = PASSWORD) {
  return createUser(db, { email, name: email.split('@')[0]!, role, password })
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

async function setExpiry(token: string, expiresAt: Date) {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, sha256Hex(token)))
}

async function sessionIds() {
  return (await db.select({ id: sessions.id }).from(sessions)).map((row) => row.id)
}

async function activeAdminCount() {
  const rows = await db.select().from(users)
  return rows.filter((u) => u.role === 'admin' && u.disabledAt === null).length
}

test('the policy constants have the agreed values', () => {
  expect(MIN_PASSWORD_LENGTH).toBe(12)
  expect(MAX_PASSWORD_LENGTH).toBe(1024)
  expect(SESSION_TTL_MS).toBe(7 * DAY_MS)
  expect(SESSION_RENEW_BELOW_MS).toBe(6 * DAY_MS)
})

test('hashPassword produces an argon2id hash that only the right password verifies against', async () => {
  const hash = await hashPassword(PASSWORD)
  expect(hash).toMatch(/^\$argon2id\$/)
  expect(hash).not.toContain(PASSWORD)
  expect(await verifyPassword(hash, PASSWORD)).toBe(true)
  expect(await verifyPassword(hash, `${PASSWORD}!`)).toBe(false)
  expect(await verifyPassword('not a hash', PASSWORD)).toBe(false)
})

test('generatePassword returns 20 random alphanumeric characters', () => {
  const passwords = Array.from({ length: 20 }, () => generatePassword())
  for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9]{20}$/)
  expect(new Set(passwords).size).toBe(passwords.length)
  expect(generatePassword().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
})

test('createUser lowercases email and refuses short passwords', async () => {
  const user = await createUser(db, { email: '  A@X.io ', name: 'Ann', role: 'admin', password: PASSWORD })
  expect(user).toMatchObject({ email: 'a@x.io', name: 'Ann', role: 'admin', disabledAt: null })
  const [stored] = await db.select().from(users).where(eq(users.id, user.id))
  expect(stored!.passwordHash).toMatch(/^\$argon2id\$/)
  expect(stored!.passwordHash).not.toContain(PASSWORD)

  const error = await createUser(db, { email: 'b@x.io', name: 'Bob', role: 'member', password: 'short' }).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('password must be at least 12 characters')
  expect(await listUsers(db)).toHaveLength(1)
})

test('createUser accepts a password of exactly the minimum length', async () => {
  const user = await createUser(db, { email: 'a@x.io', name: 'Ann', role: 'member', password: 'a'.repeat(12) })
  expect(user.email).toBe('a@x.io')
})

test('createUser validates email, name and role', async () => {
  const base = { email: 'a@x.io', name: 'Ann', role: 'member', password: PASSWORD } as const
  await expect(createUser(db, { ...base, email: 'no-at-sign' })).rejects.toBeInstanceOf(ValidationError)
  await expect(createUser(db, { ...base, email: '   ' })).rejects.toBeInstanceOf(ValidationError)
  await expect(createUser(db, { ...base, name: '  ' })).rejects.toBeInstanceOf(ValidationError)
  await expect(createUser(db, { ...base, role: 'owner' as 'admin' })).rejects.toBeInstanceOf(ValidationError)
  expect(await listUsers(db)).toHaveLength(0)
})

test('createUser rejects a duplicate email, ignoring case', async () => {
  await makeUser('a@x.io')
  const error = await makeUser('A@X.IO').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('a user with this email already exists')
  expect(await listUsers(db)).toHaveLength(1)
})

test('listUsers is ordered by email', async () => {
  await makeUser('carol@x.io')
  await makeUser('alice@x.io')
  await makeUser('bob@x.io')
  expect((await listUsers(db)).map((u) => u.email)).toEqual(['alice@x.io', 'bob@x.io', 'carol@x.io'])
})

test('findUserByEmail finds a user whatever the case or padding of the email, without the password hash', async () => {
  const created = await makeUser('alice@x.io')
  await makeUser('bob@x.io')

  const found = await findUserByEmail(db, '  Alice@X.IO ')

  expect(found).toEqual(created)
  expect('passwordHash' in found!).toBe(false)
})

test('findUserByEmail returns null for an unknown email or one with control characters', async () => {
  await makeUser('alice@x.io')

  expect(await findUserByEmail(db, 'nobody@x.io')).toBeNull()
  expect(await findUserByEmail(db, 'alice@x.io\u0000')).toBeNull()
  expect(await findUserByEmail(db, '')).toBeNull()
})

test('authenticate accepts the right password only', async () => {
  const u = await makeUser('a@x.io')
  expect(await authenticate(db, 'a@x.io', PASSWORD)).toMatchObject({ id: u.id, email: 'a@x.io' })
  expect(await authenticate(db, ' A@X.io ', PASSWORD)).toMatchObject({ id: u.id })
  expect(await authenticate(db, 'a@x.io', `${PASSWORD}x`)).toBeNull()
  expect(await authenticate(db, 'a@x.io', '')).toBeNull()
  expect(await authenticate(db, 'nobody@x.io', PASSWORD)).toBeNull()
})

test('authenticate verifies against a dummy hash for unknown emails so timing stays similar', async () => {
  await makeUser('a@x.io')
  expect(await authenticate(db, 'nobody@x.io', PASSWORD)).toBeNull()
  expect(verifySpy).toHaveBeenCalledTimes(1)
  expect(await authenticate(db, 'nobody@x.io', PASSWORD)).toBeNull()
  expect(verifySpy).toHaveBeenCalledTimes(2)
  const [dummyHash] = vi.mocked(verifySpy).mock.calls[0]!
  expect(dummyHash).toMatch(/^\$argon2id\$/)
  // The dummy hash is computed once and reused.
  expect(vi.mocked(verifySpy).mock.calls[1]![0]).toBe(dummyHash)
})

test('disabled users cannot authenticate and lose their sessions', async () => {
  await makeUser('admin@x.io', 'admin')
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  expect(await resolveSession(db, token)).not.toBeNull()

  await setUserDisabled(db, u.id, true)

  expect(await resolveSession(db, token)).toBeNull()
  expect(await authenticate(db, u.email, PASSWORD)).toBeNull()
  expect(await sessionIds()).toEqual([])
  const [row] = await db.select().from(users).where(eq(users.id, u.id))
  expect(row!.disabledAt).toBeInstanceOf(Date)
})

test('re-enabling a user lets them authenticate again', async () => {
  await makeUser('admin@x.io', 'admin')
  const u = await makeUser('a@x.io')
  await setUserDisabled(db, u.id, true)
  await setUserDisabled(db, u.id, false)
  expect(await authenticate(db, u.email, PASSWORD)).toMatchObject({ id: u.id, disabledAt: null })
})

test('resolveSession rejects a session whose user was disabled directly in the database', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id))
  expect(await resolveSession(db, token)).toBeNull()
})

test('createSession returns a 32-byte base64url token that is unique per session', async () => {
  const u = await makeUser('a@x.io')
  const before = Date.now()
  const a = await createSession(db, u.id)
  const b = await createSession(db, u.id)
  expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(b.token).not.toBe(a.token)
  expect(a.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS)
  expect(a.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS)
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sha256Hex(a.token)))
  expect(row).toMatchObject({ userId: u.id })
  expect(row!.expiresAt.getTime()).toBe(a.expiresAt.getTime())
})

test('sessions store only a hash of the token', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  const ids = await sessionIds()
  expect(ids).toHaveLength(1)
  expect(ids[0]).not.toBe(token)
  expect(ids[0]).toBe(sha256Hex(token))
})

test('resolveSession returns the user for a fresh session without renewing it', async () => {
  const u = await makeUser('a@x.io', 'admin')
  const { token, expiresAt } = await createSession(db, u.id)
  const resolved = await resolveSession(db, token)
  expect(resolved).toMatchObject({
    user: { id: u.id, email: 'a@x.io', role: 'admin' },
    sessionId: sha256Hex(token),
    renewed: false,
  })
  expect(resolved!.expiresAt.getTime()).toBe(expiresAt.getTime())
})

test('resolveSession returns null for unknown or empty tokens', async () => {
  const u = await makeUser('a@x.io')
  await createSession(db, u.id)
  expect(await resolveSession(db, 'definitely-not-a-token')).toBeNull()
  expect(await resolveSession(db, '')).toBeNull()
})

test('expired sessions resolve to null and are purged', async () => {
  const u = await makeUser('a@x.io')
  const expired = await createSession(db, u.id)
  const live = await createSession(db, u.id)
  await setExpiry(expired.token, new Date(Date.now() - 1000))

  expect(await resolveSession(db, expired.token)).toBeNull()
  expect(await purgeExpiredSessions(db)).toBe(1)
  expect(await sessionIds()).toEqual([sha256Hex(live.token)])
  expect(await purgeExpiredSessions(db)).toBe(0)
})

test('sessions renew when less than 6 days remain', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  await setExpiry(token, new Date(Date.now() + DAY_MS))

  const before = Date.now()
  const resolved = await resolveSession(db, token)
  expect(resolved).toMatchObject({ renewed: true })
  expect(resolved!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS)
  expect(resolved!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS)

  const [row] = await db.select().from(sessions).where(eq(sessions.id, sha256Hex(token)))
  expect(row!.expiresAt.getTime()).toBe(resolved!.expiresAt.getTime())

  // Now a fresh 7-day session again, so the next resolve leaves it alone.
  expect(await resolveSession(db, token)).toMatchObject({ renewed: false })
})

test('sessions with 6 days or more remaining are not renewed', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  const expiresAt = new Date(Date.now() + SESSION_RENEW_BELOW_MS + 60_000)
  await setExpiry(token, expiresAt)

  const resolved = await resolveSession(db, token)
  expect(resolved).toMatchObject({ renewed: false })
  expect(resolved!.expiresAt.getTime()).toBe(expiresAt.getTime())
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sha256Hex(token)))
  expect(row!.expiresAt.getTime()).toBe(expiresAt.getTime())
})

test('deleteSession ends only that session', async () => {
  const u = await makeUser('a@x.io')
  const first = await createSession(db, u.id)
  const second = await createSession(db, u.id)
  expect(await deleteSession(db, first.token)).toBe(u.id)
  expect(await resolveSession(db, first.token)).toBeNull()
  expect(await resolveSession(db, second.token)).not.toBeNull()
  expect(await deleteSession(db, first.token)).toBeNull()
})

test('cannot disable or demote the last active admin', async () => {
  const admin = await makeUser('admin@x.io', 'admin')
  await makeUser('member@x.io')

  for (const attempt of [() => setUserRole(db, admin.id, 'member'), () => setUserDisabled(db, admin.id, true)]) {
    const error = await attempt().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe('at least one active admin is required')
  }
  const [row] = await db.select().from(users).where(eq(users.id, admin.id))
  expect(row).toMatchObject({ role: 'admin', disabledAt: null })
})

test('a refused disable keeps the admin sessions', async () => {
  const admin = await makeUser('admin@x.io', 'admin')
  const { token } = await createSession(db, admin.id)
  await expect(setUserDisabled(db, admin.id, true)).rejects.toBeInstanceOf(ValidationError)
  expect(await resolveSession(db, token)).not.toBeNull()
})

test('with two admins one may be demoted, then the other is protected', async () => {
  const a = await makeUser('a@x.io', 'admin')
  const b = await makeUser('b@x.io', 'admin')
  await setUserRole(db, a.id, 'member')
  await expect(setUserRole(db, b.id, 'member')).rejects.toBeInstanceOf(ValidationError)
  await expect(setUserDisabled(db, b.id, true)).rejects.toBeInstanceOf(ValidationError)
  expect(await activeAdminCount()).toBe(1)
})

test('disabled admins do not count as active admins', async () => {
  const a = await makeUser('a@x.io', 'admin')
  const b = await makeUser('b@x.io', 'admin')
  await setUserDisabled(db, b.id, true)
  await expect(setUserRole(db, a.id, 'member')).rejects.toBeInstanceOf(ValidationError)
  await expect(setUserDisabled(db, a.id, true)).rejects.toBeInstanceOf(ValidationError)
  // Demoting or re-disabling the already disabled admin does not reduce the active count.
  await setUserRole(db, b.id, 'member')
  await setUserDisabled(db, b.id, true)
  expect(await activeAdminCount()).toBe(1)
})

test('members can be disabled, demoted or promoted freely', async () => {
  const admin = await makeUser('admin@x.io', 'admin')
  const m = await makeUser('m@x.io')
  await setUserRole(db, m.id, 'member')
  await setUserDisabled(db, m.id, true)
  await setUserRole(db, m.id, 'admin')
  await setUserDisabled(db, m.id, false)
  await setUserRole(db, admin.id, 'member')
  expect((await listUsers(db)).map((u) => [u.email, u.role])).toEqual([
    ['admin@x.io', 'member'],
    ['m@x.io', 'admin'],
  ])
})

test('concurrent demotions and disables cannot remove every active admin', async () => {
  for (let round = 0; round < 8; round++) {
    await t.reset()
    const a = await makeUser('a@x.io', 'admin')
    const b = await makeUser('b@x.io', 'admin')
    const first = round % 2 === 0 ? setUserRole(db, a.id, 'member') : setUserDisabled(db, a.id, true)
    const second = round % 4 < 2 ? setUserRole(db, b.id, 'member') : setUserDisabled(db, b.id, true)

    const results = await Promise.allSettled([first, second])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(ValidationError)
    expect(rejected.reason.message).toBe('at least one active admin is required')
    expect(await activeAdminCount()).toBe(1)
  }
})

test('set* functions report unknown users as validation errors', async () => {
  await makeUser('admin@x.io', 'admin')
  const missing = '00000000-0000-4000-8000-000000000000'
  for (const id of [missing, 'not-a-uuid']) {
    await expect(setUserRole(db, id, 'member')).rejects.toThrow('user not found')
    await expect(setUserDisabled(db, id, true)).rejects.toThrow('user not found')
    await expect(setPassword(db, id, PASSWORD)).rejects.toThrow('user not found')
    await expect(setUserRole(db, id, 'member')).rejects.toBeInstanceOf(ValidationError)
  }
})

test('setUserRole refuses an unknown role', async () => {
  const u = await makeUser('a@x.io')
  await expect(setUserRole(db, u.id, 'owner' as 'admin')).rejects.toBeInstanceOf(ValidationError)
})

test('setPassword invalidates existing sessions', async () => {
  const u = await makeUser('a@x.io')
  const other = await makeUser('b@x.io')
  const mine = await createSession(db, u.id)
  const theirs = await createSession(db, other.id)

  await setPassword(db, u.id, 'a brand new passphrase')

  expect(await resolveSession(db, mine.token)).toBeNull()
  expect(await resolveSession(db, theirs.token)).not.toBeNull()
  expect(await authenticate(db, u.email, PASSWORD)).toBeNull()
  expect(await authenticate(db, u.email, 'a brand new passphrase')).toMatchObject({ id: u.id })
})

test('setPassword refuses short passwords and keeps the old password and sessions', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  const error = await setPassword(db, u.id, 'short').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('password must be at least 12 characters')
  expect(await authenticate(db, u.email, PASSWORD)).not.toBeNull()
  expect(await resolveSession(db, token)).not.toBeNull()
})

test('a password from generatePassword is accepted by createUser and setPassword', async () => {
  const password = generatePassword()
  const u = await makeUser('a@x.io', 'member', password)
  expect(await authenticate(db, 'a@x.io', password)).not.toBeNull()
  const next = generatePassword()
  await setPassword(db, u.id, next)
  expect(await authenticate(db, 'a@x.io', next)).not.toBeNull()
})

// --- password hashes never leave the module -------------------------------------------------------------

test('createUser, authenticate, resolveSession and listUsers never return the password hash', async () => {
  const created = await makeUser('a@x.io')
  expect('passwordHash' in created).toBe(false)
  expect(created).toEqual({
    id: created.id,
    email: 'a@x.io',
    name: 'a',
    role: 'member',
    disabledAt: null,
    createdAt: expect.any(Date),
  })

  const authenticated = await authenticate(db, 'a@x.io', PASSWORD)
  expect(authenticated).not.toBeNull()
  expect('passwordHash' in authenticated!).toBe(false)
  expect(authenticated).toEqual(created)

  const { token } = await createSession(db, created.id)
  const resolved = await resolveSession(db, token)
  expect(resolved).not.toBeNull()
  expect('passwordHash' in resolved!.user).toBe(false)
  expect(resolved!.user).toEqual(created)

  const listed = await listUsers(db)
  expect(listed).toHaveLength(1)
  expect('passwordHash' in listed[0]!).toBe(false)
  expect(listed[0]).toEqual(created)
  expect(JSON.stringify([created, authenticated, resolved, listed])).not.toContain('argon2')
})

// A trigger makes the next INSERT/UPDATE on users fail inside Postgres, like a dropped connection or a
// statement timeout would. Drizzle's own error for that embeds the statement parameters, hash included.
async function withFailingTrigger<T>(event: 'INSERT' | 'UPDATE', fn: () => Promise<T>): Promise<T> {
  await t.sql.unsafe(
    `create or replace function vpsm_test_fail() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end $$`,
  )
  await t.sql.unsafe(`create trigger vpsm_test_fail before ${event} on users for each row execute function vpsm_test_fail()`)
  try {
    return await fn()
  } finally {
    await t.sql.unsafe('drop trigger vpsm_test_fail on users')
  }
}

test('the failure injection really would leak a hash through a raw drizzle error', async () => {
  const error = await withFailingTrigger('INSERT', () =>
    db.insert(users).values({ email: 'a@x.io', name: 'a', role: 'member', passwordHash: '$argon2id$sentinel' }),
  ).catch((e: unknown) => e)
  expect(inspect(error)).toContain('$argon2id$sentinel')
})

test('createUser reports other database failures without the hash or a cause', async () => {
  const error = await withFailingTrigger('INSERT', () => makeUser('a@x.io')).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('database error while creating user')
  expect((error as Error).cause).toBeUndefined()
  expect(inspect(error)).not.toContain('argon2')
  expect(await listUsers(db)).toHaveLength(0)
})

test('setPassword reports other database failures without the hash or a cause', async () => {
  const u = await makeUser('a@x.io')
  const { token } = await createSession(db, u.id)
  const error = await withFailingTrigger('UPDATE', () => setPassword(db, u.id, 'a brand new passphrase')).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('database error while setting password')
  expect((error as Error).cause).toBeUndefined()
  expect(inspect(error)).not.toContain('argon2')
  // The failed change rolled back: old password and session still work.
  expect(await authenticate(db, u.email, PASSWORD)).not.toBeNull()
  expect(await resolveSession(db, token)).not.toBeNull()
})

// --- input hardening ---------------------------------------------------------------------------------

test('createUser rejects control characters in email and name before touching the database', async () => {
  const base = { email: 'a@x.io', name: 'Ann', role: 'member', password: PASSWORD } as const
  for (const bad of ['\u0000', '\n', '\t', '\u001f', '\u007f']) {
    const nameError = await createUser(db, { ...base, name: `Bob${bad}x` }).catch((e: unknown) => e)
    expect(nameError).toBeInstanceOf(ValidationError)
    expect((nameError as Error).message).toBe('name contains invalid characters')

    const emailError = await createUser(db, { ...base, email: `a${bad}b@x.io` }).catch((e: unknown) => e)
    expect(emailError).toBeInstanceOf(ValidationError)
    expect((emailError as Error).message).toBe('email contains invalid characters')
  }
  // A trailing NUL is not whitespace, so trim() keeps it and it must still be rejected.
  await expect(createUser(db, { ...base, name: 'Bob\u0000' })).rejects.toThrow('name contains invalid characters')
  expect(await listUsers(db)).toHaveLength(0)
})

test('createUser and setPassword accept passwords up to 1024 characters and refuse longer ones', async () => {
  const longest = 'p'.repeat(MAX_PASSWORD_LENGTH)
  const u = await makeUser('a@x.io', 'member', longest)
  expect(await authenticate(db, 'a@x.io', longest)).not.toBeNull()
  await setPassword(db, u.id, `${longest.slice(1)}q`)

  const tooLong = 'p'.repeat(MAX_PASSWORD_LENGTH + 1)
  for (const attempt of [() => makeUser('b@x.io', 'member', tooLong), () => setPassword(db, u.id, tooLong)]) {
    const error = await attempt().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe('password must be at most 1024 characters')
  }
  expect(await listUsers(db)).toHaveLength(1)
})

test('createUser and setPassword refuse control characters in passwords, so every stored password can log in', async () => {
  const u = await makeUser('a@x.io')
  for (const bad of ['\u0000', '\n', '\t', '\u007f']) {
    const password = `valid password${bad}`
    for (const attempt of [() => makeUser('b@x.io', 'member', password), () => setPassword(db, u.id, password)]) {
      const error = await attempt().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as Error).message).toBe('password contains invalid characters')
    }
  }
  expect(await listUsers(db)).toHaveLength(1)
  expect(await authenticate(db, u.email, PASSWORD)).not.toBeNull()
})

test('authenticate returns null for control characters or oversized passwords without a query or a hash check', async () => {
  const unusable = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be queried for rejected input')
      },
    },
  ) as unknown as Db

  for (const [email, password] of [
    ['a@x.io', 'password\u0000'],
    ['a@x.io', 'pass\nword12345'],
    ['a\u0000@x.io', PASSWORD],
    ['a@x.io\u007fx', PASSWORD],
    ['a@x.io', 'p'.repeat(MAX_PASSWORD_LENGTH + 1)],
  ] as const) {
    expect(await authenticate(unusable, email, password)).toBeNull()
  }
  expect(verifySpy).not.toHaveBeenCalled()
})

// --- createSession -----------------------------------------------------------------------------------

test('createSession refuses disabled and unknown users and stores nothing', async () => {
  await makeUser('admin@x.io', 'admin')
  const u = await makeUser('a@x.io')
  await setUserDisabled(db, u.id, true)

  const disabled = await createSession(db, u.id).catch((e: unknown) => e)
  expect(disabled).toBeInstanceOf(ValidationError)
  expect((disabled as Error).message).toBe('user is disabled')

  for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    const unknown = await createSession(db, id).catch((e: unknown) => e)
    expect(unknown).toBeInstanceOf(ValidationError)
    expect((unknown as Error).message).toBe('user not found')
  }
  expect(await sessionIds()).toEqual([])

  await setUserDisabled(db, u.id, false)
  expect((await createSession(db, u.id)).token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await sessionIds()).toHaveLength(1)
})

test('createSession waits for an in-flight disable and then refuses, so no session outlives it', async () => {
  const u = await makeUser('a@x.io')
  let signalLocked!: () => void
  const locked = new Promise<void>((resolve) => (signalLocked = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const disabling = t.sql.begin(async (tx) => {
    await tx`update users set disabled_at = now() where id = ${u.id}`
    signalLocked()
    await released
  })
  await locked

  const creating = createSession(db, u.id).catch((e: unknown) => e)
  const early = await Promise.race([creating, new Promise((resolve) => setTimeout(() => resolve('pending'), 300))])
  expect(early).toBe('pending')

  release()
  await disabling
  const error = await creating
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('user is disabled')
  expect(await sessionIds()).toEqual([])
})
