import { createHash, randomBytes, randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { and, asc, eq, getTableColumns, gt, isNull, lte, sql } from 'drizzle-orm'
import type { Db } from './client'
import { ValidationError, violatedUniqueConstraint } from './errors'
import { CONTROL_CHARACTERS, isUuid, normalizeEmail } from './input'
import { sessions, type User, users } from './schema'

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024
export const SESSION_TTL_MS = 7 * 24 * 3600_000
// A session with less than this much life left is extended to a full SESSION_TTL_MS when it is used.
export const SESSION_RENEW_BELOW_MS = 6 * 24 * 3600_000

type Role = User['role']
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// A user as seen outside this module. The password hash is only ever read by authenticate(), never returned.
export type SafeUser = Omit<User, 'passwordHash'>
const { passwordHash: _passwordHash, ...safeUserColumns } = getTableColumns(users)

const GENERATED_PASSWORD_LENGTH = 20
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/
const LAST_ADMIN_MESSAGE = 'at least one active admin is required'

// --- passwords ---------------------------------------------------------------------------------------

// Library defaults: argon2id (m=19456 KiB, t=2, p=1). The PHC string carries the parameters and salt.
export function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

// A hash that cannot be decoded can never match, so it counts as a mismatch; any other failure propagates.
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'InvalidArg') return false
    throw error
  }
}

export function generatePassword(): string {
  let password = ''
  for (let n = 0; n < GENERATED_PASSWORD_LENGTH; n++) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  return password
}

// Control characters are refused when a password is set (not only at login) so that every stored password
// is one authenticate() will accept.
function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
  if (CONTROL_CHARACTERS.test(password)) throw new ValidationError('password contains invalid characters')
}

// authenticate() verifies against this when the email is unknown, so "no such user" costs about as much as
// "wrong password". Computed on first use; a failed attempt is not cached.
let dummyHash: Promise<string> | undefined
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex')).catch((error: unknown) => {
    dummyHash = undefined
    throw error
  })
  return dummyHash
}

// --- users -------------------------------------------------------------------------------------------

function assertRole(role: string): asserts role is Role {
  if (role !== 'admin' && role !== 'member') throw new ValidationError('role must be "admin" or "member"')
}

// Unknown ids and ids that are not even UUIDs are the same thing to callers; avoid a Postgres cast error.
function assertUserId(userId: string): void {
  if (!isUuid(userId)) throw new ValidationError('user not found')
}

// Drizzle's query errors put the statement *parameters* in their message, and util.inspect prints the `cause`
// chain, so an unexpected failure of a statement that carries a password hash would write the hash to logs.
// Those failures are replaced by this error, which keeps neither.
function databaseError(operation: string): Error {
  return new Error(`database error while ${operation}`)
}

export async function createUser(
  db: Db,
  i: { email: string; name: string; role: Role; password: string },
): Promise<SafeUser> {
  const email = normalizeEmail(i.email)
  if (CONTROL_CHARACTERS.test(email)) throw new ValidationError('email contains invalid characters')
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError(`invalid email address "${email}"`)
  const name = i.name.trim()
  if (CONTROL_CHARACTERS.test(name)) throw new ValidationError('name contains invalid characters')
  if (name === '') throw new ValidationError('name is required')
  assertRole(i.role)
  assertValidPassword(i.password)

  const passwordHash = await hashPassword(i.password)
  try {
    const [user] = await db
      .insert(users)
      .values({ email, name, passwordHash, role: i.role })
      .returning(safeUserColumns)
    return user!
  } catch (error) {
    if (violatedUniqueConstraint(error) === 'users_email_unique') {
      throw new ValidationError('a user with this email already exists')
    }
    throw databaseError('creating user')
  }
}

export function listUsers(db: Db): Promise<SafeUser[]> {
  return db.select(safeUserColumns).from(users).orderBy(asc(users.email))
}

// Replaces the password and ends every session of that user, so a stolen session dies with the old password.
export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  assertValidPassword(password)
  assertUserId(userId)
  const passwordHash = await hashPassword(password)
  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, userId))
        .returning({ id: users.id })
      if (updated.length === 0) throw new ValidationError('user not found')
      await tx.delete(sessions).where(eq(sessions.userId, userId))
    })
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw databaseError('setting password')
  }
}

const isActiveAdmin = (user: SafeUser) => user.role === 'admin' && user.disabledAt === null

// Locks every active admin row (in id order, so concurrent callers cannot deadlock each other) and then the
// target row. Two requests that would each leave the other as the only admin therefore run one after the
// other, and the second sees the first's result. NO KEY UPDATE is enough: it conflicts with itself and with
// the UPDATEs below, but not with the KEY SHARE lock that inserting a session takes on the user row.
// Returns the locked target and how many *other* active admins there are.
async function lockUserAndAdmins(tx: Tx, userId: string): Promise<{ target: SafeUser; otherActiveAdmins: number }> {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .for('no key update')
  const [target] = await tx.select(safeUserColumns).from(users).where(eq(users.id, userId)).for('no key update')
  if (!target) throw new ValidationError('user not found')
  return { target, otherActiveAdmins: admins.filter((admin) => admin.id !== target.id).length }
}

export async function setUserRole(db: Db, userId: string, role: Role): Promise<void> {
  assertRole(role)
  assertUserId(userId)
  await db.transaction(async (tx) => {
    const { target, otherActiveAdmins } = await lockUserAndAdmins(tx, userId)
    if (role === 'member' && isActiveAdmin(target) && otherActiveAdmins === 0) {
      throw new ValidationError(LAST_ADMIN_MESSAGE)
    }
    await tx.update(users).set({ role }).where(eq(users.id, userId))
  })
}

// Disabling also ends every session of the user. Disabling an already disabled user keeps the original time.
export async function setUserDisabled(db: Db, userId: string, disabled: boolean): Promise<void> {
  assertUserId(userId)
  await db.transaction(async (tx) => {
    const { target, otherActiveAdmins } = await lockUserAndAdmins(tx, userId)
    if (disabled && isActiveAdmin(target) && otherActiveAdmins === 0) throw new ValidationError(LAST_ADMIN_MESSAGE)
    await tx
      .update(users)
      .set({ disabledAt: disabled ? (target.disabledAt ?? new Date()) : null })
      .where(eq(users.id, userId))
    if (disabled) await tx.delete(sessions).where(eq(sessions.userId, userId))
  })
}

// Returns null for an unknown email, a wrong password and a disabled account alike (callers must not be able
// to tell which). Never throws for bad credentials. Input that no stored email or password can contain
// (control characters, oversized passwords) is rejected before the database or argon2 is touched.
export async function authenticate(db: Db, email: string, password: string): Promise<SafeUser | null> {
  const normalizedEmail = normalizeEmail(email)
  if (CONTROL_CHARACTERS.test(normalizedEmail) || CONTROL_CHARACTERS.test(password)) return null
  if (password.length > MAX_PASSWORD_LENGTH) return null

  const [row] = await db
    .select({ ...safeUserColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizedEmail))
  const passwordMatches = await verifyPassword(row ? row.passwordHash : await getDummyHash(), password)
  if (!row || !passwordMatches) return null

  const { passwordHash: _hash, ...user } = row
  return user.disabledAt === null ? user : null
}

// --- sessions ----------------------------------------------------------------------------------------

// The session row id is the SHA-256 of the token: a leaked database cannot be replayed as cookies.
const sessionIdOf = (token: string) => createHash('sha256').update(token).digest('hex')

// The row is inserted by one statement that selects the user, so a user who does not exist or is disabled gets
// no session. FOR SHARE makes it wait for an in-flight setUserDisabled() on the same user and then re-check.
export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  assertUserId(userId)
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const inserted = await db.execute(sql`
    insert into sessions (id, user_id, expires_at)
    select ${sessionIdOf(token)}, u.id, ${expiresAt.toISOString()}::timestamptz
    from users u
    where u.id = ${userId} and u.disabled_at is null
    for share of u
    returning id`)
  if (inserted.length === 0) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
    throw new ValidationError(user ? 'user is disabled' : 'user not found')
  }
  return { token, expiresAt }
}

export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ user: SafeUser; sessionId: string; expiresAt: Date; renewed: boolean } | null> {
  const sessionId = sessionIdOf(token)
  const [row] = await db
    .select({ expiresAt: sessions.expiresAt, user: safeUserColumns })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
  if (!row) return null

  const now = Date.now()
  if (row.expiresAt.getTime() <= now || row.user.disabledAt !== null) return null
  if (row.expiresAt.getTime() - now >= SESSION_RENEW_BELOW_MS) {
    return { user: row.user, sessionId, expiresAt: row.expiresAt, renewed: false }
  }

  // The guard on expires_at keeps a session that expired, was deleted or was revoked meanwhile from being revived.
  const expiresAt = new Date(now + SESSION_TTL_MS)
  const extended = await db
    .update(sessions)
    .set({ expiresAt })
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date(now))))
    .returning({ id: sessions.id })
  if (extended.length === 0) return null
  return { user: row.user, sessionId, expiresAt, renewed: true }
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionIdOf(token)))
}

export async function purgeExpiredSessions(db: Db): Promise<number> {
  const purged = await db.delete(sessions).where(lte(sessions.expiresAt, new Date())).returning({ id: sessions.id })
  return purged.length
}
