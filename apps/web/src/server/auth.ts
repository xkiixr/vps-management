import { authenticate, createSession, type Db, MAX_PASSWORD_LENGTH, ValidationError } from '@vpsm/db'
import { auditBestEffort } from './audit'
import type { HeaderReader } from './origin'
import { clientIp, type LoginLimits, loginKey } from './rate-limit'
import { type CookieJar, endSession } from './session'

export const LOGIN_FAILED = 'invalid email or password'
export const LOGIN_THROTTLED = 'too many attempts, try again later'

// RFC 5321 caps an address at 254 characters; anything much longer cannot be an account.
const MAX_EMAIL_LENGTH = 320
// The same rule @vpsm/db applies: no stored email or password contains a C0 control character or DEL.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export type LoginResult = { error: string } | { session: { token: string; expiresAt: Date } }

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

// Input that no account can match. It is refused without a per-email limiter key (so junk cannot fill that
// limiter), the database or argon2; it still counts against the IP's limit.
const cannotMatchAnyAccount = (email: string, password: string) =>
  email.length > MAX_EMAIL_LENGTH ||
  !email.includes('@') ||
  CONTROL_CHARACTERS.test(email) ||
  password.length > MAX_PASSWORD_LENGTH ||
  CONTROL_CHARACTERS.test(password)

/**
 * Checks the credentials in a login form and opens a session (audited as `auth.login`). Every failure looks the same
 * to the caller, so the response never tells whether an email has an account. Throws only for unexpected
 * (database) failures.
 */
export async function attemptLogin(
  deps: { db: Db; limits: LoginLimits; headers: HeaderReader },
  form: FormData,
): Promise<LoginResult> {
  const { perEmail, perIp } = deps.limits
  const email = field(form, 'email').trim().toLowerCase()
  const password = field(form, 'password')
  const ip = clientIp(deps.headers)

  if (!perIp.check(ip)) return { error: LOGIN_THROTTLED }
  if (cannotMatchAnyAccount(email, password)) {
    perIp.fail(ip)
    return { error: LOGIN_FAILED }
  }
  const key = loginKey(ip, email)
  if (!perEmail.check(key)) return { error: LOGIN_THROTTLED }
  // Counted before the password is checked: the checks above and these two calls run without an await between
  // them, so concurrent requests cannot all pass check() before any of them is counted. A success clears the
  // per-email count again; the per-IP count stays, so one valid account cannot be used to reset it.
  perIp.fail(ip)
  perEmail.fail(key)

  const user = await authenticate(deps.db, email, password)
  if (!user) return { error: LOGIN_FAILED }
  perEmail.reset(key)

  let session: { token: string; expiresAt: Date }
  try {
    session = await createSession(deps.db, user.id)
  } catch (error) {
    // Disabled (or deleted) between authenticate() and here; saying so would reveal that the account exists.
    if (error instanceof ValidationError) return { error: LOGIN_FAILED }
    throw error
  }
  await auditBestEffort(deps.db, { actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, metadata: { ip } })
  return { session }
}

/** Ends the session in the cookie (see endSession) and records `auth.logout` when it belonged to a user. */
export async function logout(db: Db, jar: CookieJar): Promise<void> {
  const userId = await endSession(db, jar)
  if (userId) await auditBestEffort(db, { actorId: userId, action: 'auth.logout', targetType: 'user', targetId: userId })
}
