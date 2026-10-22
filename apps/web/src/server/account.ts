import {
  authenticate,
  createSession,
  type Db,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type SafeUser,
  setPassword,
} from '@vpsm/db'
import type { ActionState, FieldErrors } from './action-state'
import { auditBestEffort } from './audit'
import { LOGIN_THROTTLED } from './auth'
import { logServerError } from './errors'
import { hasControlCharacters } from './form'
import type { HeaderReader } from './origin'
import { refusal } from './projects'
import { clientIp, type LoginLimits, loginKey } from './rate-limit'

export const CURRENT_PASSWORD_INCORRECT = 'current password is incorrect'
export const PASSWORD_MUST_DIFFER = 'new password must be different from the current one'
export const PASSWORDS_DO_NOT_MATCH = 'passwords do not match'
export const PASSWORD_CHANGED_NOTICE = 'Password changed. You were signed out everywhere else.'
export const PASSWORD_CHANGED_SIGN_IN = 'password changed, but signing you in failed: sign in with the new password'

export type ChangePasswordResult = Pick<ActionState, 'error' | 'fieldErrors'> | { session: { token: string; expiresAt: Date } }

// What is wrong with the new password on its own. None of it depends on the current password, so saying it
// tells nothing about that, and a typo here does not cost an attempt at the current password.
function newPasswordProblems(next: string, confirm: string): FieldErrors | null {
  if (next.length < MIN_PASSWORD_LENGTH) return { newPassword: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }
  if (next.length > MAX_PASSWORD_LENGTH) return { newPassword: `password must be at most ${MAX_PASSWORD_LENGTH} characters` }
  if (hasControlCharacters(next)) return { newPassword: 'password contains invalid characters' }
  if (confirm !== next) return { confirmPassword: PASSWORDS_DO_NOT_MATCH }
  return null
}

/**
 * Changes the signed-in user's own password (audited as `user.change_password`, without any secret) and opens a
 * new session for them: setPassword ends every session, this one included.
 *
 * The form asks for the current password, so a stolen session cannot be used to take over the account. A wrong
 * current password counts against the same limits as a wrong password at login (keyed by IP and email, shared
 * with the login form), so this form is no way around them. "Must differ from the current one" is only said once
 * the current one was right: before that it would tell whether a guess was right.
 */
export async function doChangeOwnPassword(
  deps: { db: Db; limits: LoginLimits; headers: HeaderReader },
  user: SafeUser,
  input: { currentPassword?: string; newPassword?: string; confirmPassword?: string },
): Promise<ChangePasswordResult> {
  const current = input.currentPassword ?? ''
  const next = input.newPassword ?? ''
  const fieldErrors = newPasswordProblems(next, input.confirmPassword ?? '')
  if (fieldErrors) return { fieldErrors }

  const { perEmail, perIp } = deps.limits
  const ip = clientIp(deps.headers)
  const key = loginKey(ip, user.email)
  if (!perIp.check(ip) || !perEmail.check(key)) return { error: LOGIN_THROTTLED }
  // Counted before the password is checked, with no await in between (see attemptLogin): concurrent requests
  // cannot all pass check() before any of them is counted. A success clears the per-email count again.
  perIp.fail(ip)
  perEmail.fail(key)

  const verified = await authenticate(deps.db, user.email, current)
  if (verified?.id !== user.id) return { error: CURRENT_PASSWORD_INCORRECT }
  perEmail.reset(key)
  if (next === current) return { fieldErrors: { newPassword: PASSWORD_MUST_DIFFER } }

  const failed = await refusal(() => setPassword(deps.db, user.id, next))
  if (failed) return failed
  await auditBestEffort(deps.db, { actorId: user.id, action: 'user.change_password', targetType: 'user', targetId: user.id })

  try {
    return { session: await createSession(deps.db, user.id) }
  } catch (error) {
    // The password is changed and every session is gone, so the user has to sign in. Nothing here is a secret.
    logServerError('opening a session after a password change', error)
    return { error: PASSWORD_CHANGED_SIGN_IN }
  }
}
