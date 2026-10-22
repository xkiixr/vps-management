import { authenticate, createSession, type Db, MAX_PASSWORD_LENGTH, ValidationError } from '@vpsm/db'
import type { HeaderReader } from './origin'
import { clientIp, type LoginLimiter, loginKey } from './rate-limit'

export const LOGIN_FAILED = 'invalid email or password'
export const LOGIN_THROTTLED = 'too many attempts, try again later'

// RFC 5321 caps an address at 254 characters; anything much longer cannot be an account and would only bloat the
// limiter's keys.
const MAX_EMAIL_LENGTH = 320

export type LoginResult = { error: string } | { session: { token: string; expiresAt: Date } }

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/**
 * Checks the credentials in a login form and opens a session. Every failure looks the same to the caller, so the
 * response never tells whether an email has an account. Throws only for unexpected (database) failures.
 */
export async function attemptLogin(
  deps: { db: Db; limiter: LoginLimiter; headers: HeaderReader },
  form: FormData,
): Promise<LoginResult> {
  const email = field(form, 'email')
  const password = field(form, 'password')
  // No stored account can match these; refused before they reach the limiter, the database or argon2.
  if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) return { error: LOGIN_FAILED }

  const key = loginKey(clientIp(deps.headers), email)
  if (!deps.limiter.check(key)) return { error: LOGIN_THROTTLED }
  // Counted before the password is checked: check() and fail() run without an await between them, so concurrent
  // requests cannot all pass check() before any of them is counted. A success clears the count again.
  deps.limiter.fail(key)

  const user = await authenticate(deps.db, email, password)
  if (!user) return { error: LOGIN_FAILED }
  deps.limiter.reset(key)

  try {
    return { session: await createSession(deps.db, user.id) }
  } catch (error) {
    // Disabled (or deleted) between authenticate() and here; saying so would reveal that the account exists.
    if (error instanceof ValidationError) return { error: LOGIN_FAILED }
    throw error
  }
}
