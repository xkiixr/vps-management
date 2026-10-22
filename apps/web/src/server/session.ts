import { deleteSession, resolveSession, type Db, type SafeUser } from '@vpsm/db'

// `__Host-`: the browser only accepts it with Secure, Path=/ and no Domain, so an app on a sibling subdomain of
// the panel cannot set or overwrite it.
export const SESSION_COOKIE = '__Host-vpsm_session'

export type SessionCookieOptions = {
  httpOnly: true
  secure: true
  sameSite: 'lax'
  path: '/'
  expires: Date
  maxAge: number
}

/** The part of a cookie store this module needs; Next's `cookies()` and `NextResponse#cookies` both fit. */
export interface CookieJar {
  get(name: string): { value: string } | undefined
  set(name: string, value: string, options: SessionCookieOptions): unknown
}

export function sessionCookieOptions(expiresAt: Date, now: number = Date.now()): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000)),
  }
}

export function setSessionCookie(jar: CookieJar, token: string, expiresAt: Date): void {
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
}

// Deleting is setting an expired cookie with the same attributes: a __Host- cookie sent back without Secure and
// Path=/ (as cookies().delete() would) is rejected by the browser and the old one stays.
export function clearSessionCookie(jar: CookieJar): void {
  jar.set(SESSION_COOKIE, '', sessionCookieOptions(new Date(0), 0))
}

/**
 * The signed-in user for the session cookie in `jar`, or null (no cookie, unknown or expired session, disabled
 * user). When the session is renewed the cookie is set again with the new expiry.
 */
export async function resolveSessionUser(db: Db, jar: CookieJar): Promise<SafeUser | null> {
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await resolveSession(db, token)
  if (!session) return null
  if (session.renewed) setSessionCookie(jar, token, session.expiresAt)
  return session.user
}

/** Logout: the session row is deleted and the cookie cleared. */
export async function endSession(db: Db, jar: CookieJar): Promise<void> {
  const token = jar.get(SESSION_COOKIE)?.value
  try {
    if (token) await deleteSession(db, token)
  } finally {
    clearSessionCookie(jar)
  }
}
