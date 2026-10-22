import { createHash, randomBytes, randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm'
import type { Db } from './client'
import { ValidationError, violatedUniqueConstraint } from './errors'
import { sessions, type User, users } from './schema'

export const MIN_PASSWORD_LENGTH = 12
export const SESSION_TTL_MS = 7 * 24 * 3600_000
// A session with less than this much life left is extended to a full SESSION_TTL_MS when it is used.
export const SESSION_RENEW_BELOW_MS = 6 * 24 * 3600_000

type Role = User['role']
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const GENERATED_PASSWORD_LENGTH = 20
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function assertRole(role: string): asserts role is Role {
  if (role !== 'admin' && role !== 'member') throw new ValidationError('role must be "admin" or "member"')
}

// Unknown ids and ids that are not even UUIDs are the same thing to callers; avoid a Postgres cast error.
function assertUserId(userId: string): void {
  if (!UUID_PATTERN.test(userId)) throw new ValidationError('user not found')
}

export async function createUser(
  db: Db,
  i: { email: string; name: string; role: Role; password: string },
): Promise<User> {
  const email = normalizeEmail(i.email)
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError(`invalid email address "${email}"`)
  const name = i.name.trim()
  if (name === '') throw new ValidationError('name is required')
  assertRole(i.role)
  assertPasswordLength(i.password)

  const passwordHash = await hashPassword(i.password)
  try {
    const [user] = await db.insert(users).values({ email, name, passwordHash, role: i.role }).returning()
    return user!
  } catch (error) {
    if (violatedUniqueConstraint(error) === 'users_email_unique') {
      throw new ValidationError('a user with this email already exists')
    }
    throw error
  }
}

export function listUsers(db: Db): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.email))
}

// Replaces the password and ends every session of that user, so a stolen session dies with the old password.
export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  assertPasswordLength(password)
  assertUserId(userId)
  const passwordHash = await hashPassword(password)
  await db.transaction(async (tx) => {
    const updated = await tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).returning({ id: users.id })
    if (updated.length === 0) throw new ValidationError('user not found')
    await tx.delete(sessions).where(eq(sessions.userId, userId))
  })
}

const isActiveAdmin = (user: User) => user.role === 'admin' && user.disabledAt === null

// Locks every active admin row (in id order, so concurrent callers cannot deadlock each other) and then the
// target row. Two requests that would each leave the other as the only admin therefore run one after the
// other, and the second sees the first's result. Returns the locked target and how many *other* active admins
// there are.
async function lockUserAndAdmins(tx: Tx, userId: string): Promise<{ target: User; otherActiveAdmins: number }> {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .for('update')
  const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
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
// to tell which). Never throws for bad credentials.
export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)))
  const passwordMatches = await verifyPassword(user ? user.passwordHash : await getDummyHash(), password)
  return user && passwordMatches && user.disabledAt === null ? user : null
}

// --- sessions ----------------------------------------------------------------------------------------

// The session row id is the SHA-256 of the token: a leaked database cannot be replayed as cookies.
const sessionIdOf = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({ id: sessionIdOf(token), userId, expiresAt })
  return { token, expiresAt }
}

export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ user: User; sessionId: string; expiresAt: Date; renewed: boolean } | null> {
  const sessionId = sessionIdOf(token)
  const [row] = await db
    .select({ expiresAt: sessions.expiresAt, user: users })
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
