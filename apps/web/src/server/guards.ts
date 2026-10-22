import { cookies, headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import type { Actor, Db, SafeUser } from '@vpsm/db'
import { webConfig } from './config'
import { getDb } from './db'
import { assertSameOrigin } from './origin'
import { type CookieJar, resolveSessionUser } from './session'

export function ensureUser(user: SafeUser | null): SafeUser {
  if (!user) redirect('/login')
  return user
}

// A member gets the ordinary 404: nothing tells them an admin page is there.
export function ensureAdmin(user: SafeUser): SafeUser {
  if (user.role !== 'admin') notFound()
  return user
}

// Next's cookie store for this request. It is writable in server actions and route handlers only; a Server
// Component render refuses Set-Cookie, so a renewal noticed there cannot update the cookie. That is fine: for page
// loads proxy.ts has already renewed the session (and its cookie) before rendering starts.
async function requestCookies(): Promise<CookieJar> {
  const store = await cookies()
  return {
    get: (name) => store.get(name),
    set(name, value, options) {
      try {
        store.set(name, value, options)
      } catch {
        // Read-only during a Server Component render (see above).
      }
    },
  }
}

/** The signed-in user, or null. Memoised per request, so a layout and its page share one lookup. */
export const currentUser = cache(async (): Promise<SafeUser | null> => {
  // Cookies first: reading them is what marks the page as rendered per request (never prerendered at build time,
  // when there is no database to connect to).
  const jar = await requestCookies()
  return resolveSessionUser(getDb(), jar)
})

/**
 * The signed-in user of a route handler that answers a read (GET) with JSON, or null: the handler answers 401
 * itself, because a redirect to the login page is no use to a script. It sets no cookie. proxy.ts has renewed the
 * session and its cookie before any GET gets here, so there is nothing for the handler to add, and a poll
 * should not carry a Set-Cookie of its own.
 */
export async function apiUser(): Promise<SafeUser | null> {
  const store = await cookies()
  return resolveSessionUser(getDb(), { get: (name) => store.get(name), set: () => {} })
}

/** The signed-in user; anyone else is redirected to /login. */
export async function requireUser(): Promise<SafeUser> {
  return ensureUser(await currentUser())
}

/** The signed-in admin; members get a 404 and anyone not signed in is redirected to /login. */
export async function requireAdmin(): Promise<SafeUser> {
  return ensureAdmin(await requireUser())
}

/**
 * The start of every server action that works for a signed-in user, and the only way one starts: the request
 * must come from the panel's own pages (see assertSameOrigin), then there must be a signed-in user (anyone else
 * is sent to /login). Nothing else is read or done before both. Returns what the action needs to work as that user.
 */
export async function beginAction(): Promise<{ db: Db; actor: Actor; user: SafeUser }> {
  assertSameOrigin(await headers(), webConfig().panelOrigin)
  const user = await requireUser()
  return { db: getDb(), actor: { id: user.id, role: user.role }, user }
}

/**
 * The start of every server action that only an admin may take (user administration, system settings), and the
 * only way one starts: the same-origin check, then the signed-in user as in beginAction, who must be an admin. A
 * member gets the 404 page, exactly as for the admin pages, whatever the action was asked to do.
 */
export async function beginAdminAction(): Promise<{ db: Db; actor: Actor; user: SafeUser }> {
  assertSameOrigin(await headers(), webConfig().panelOrigin)
  const user = await requireAdmin()
  return { db: getDb(), actor: { id: user.id, role: user.role }, user }
}
