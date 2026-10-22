'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { attemptLogin, logout } from '../auth'
import { webConfig } from '../config'
import { getDb } from '../db'
import { actionError, logServerError } from '../errors'
import { assertSameOrigin } from '../origin'
import { loginLimits } from '../rate-limit'
import { setSessionCookie } from '../session'

export type LoginState = { error?: string }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const h = await headers()
  assertSameOrigin(h, webConfig().panelOrigin)

  let result: Awaited<ReturnType<typeof attemptLogin>>
  try {
    result = await attemptLogin({ db: getDb(), limits: loginLimits(), headers: h }, formData)
  } catch (error) {
    return actionError(error, 'login')
  }
  if ('error' in result) return { error: result.error }

  setSessionCookie(await cookies(), result.session.token, result.session.expiresAt)
  redirect('/')
}

// Used directly as a <form action>, so it has no result to show: if deleting the session row fails, that is
// logged, the cookie is cleared anyway and the user still lands on /login.
export async function logoutAction(): Promise<void> {
  assertSameOrigin(await headers(), webConfig().panelOrigin)
  try {
    await logout(getDb(), await cookies())
  } catch (error) {
    logServerError('logout', error)
  }
  redirect('/login')
}
