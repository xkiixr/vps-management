import { type NextRequest, NextResponse } from 'next/server'
import { getDb } from './server/db'
import { logServerError } from './server/errors'
import { resolveSessionUser, SESSION_COOKIE } from './server/session'

// Keeps the session cookie's expiry in step with the session row. A Server Component cannot set cookies, so a
// session renewed while rendering a page would leave the browser with the old expiry; renewing here, before the
// page renders, lets the response carry the new cookie. This is not an access check: pages and actions still
// call requireUser()/requireAdmin(). Server actions (POST) renew through requireUser() themselves, so they are
// left alone here and only one Set-Cookie for the session can ever be on a response.
export async function proxy(request: NextRequest) {
  const response = NextResponse.next()
  if ((request.method === 'GET' || request.method === 'HEAD') && request.cookies.has(SESSION_COOKIE)) {
    try {
      await resolveSessionUser(getDb(), {
        get: (name) => request.cookies.get(name),
        set: (name, value, options) => response.cookies.set(name, value, options),
      })
    } catch (error) {
      // The page's own session lookup will fail the same way and show the error; do not fail twice.
      logServerError('session renewal', error)
    }
  }
  return response
}

// The GitHub webhook is left out: it has no session, and a request that passes through the proxy is buffered by Next
// before the route runs, while the route wants to refuse a body that is too large before reading it.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/github/webhook(?:/|$)).*)'],
}
