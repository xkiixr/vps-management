'use server'

import { cookies, headers } from 'next/headers'
import type { ActionState } from '../action-state'
import { doChangeOwnPassword, PASSWORD_CHANGED_NOTICE } from '../account'
import { actionError } from '../errors'
import { formRawText } from '../form'
import { beginAction } from '../guards'
import { loginLimits } from '../rate-limit'
import { setSessionCookie } from '../session'

export type { ActionState, FieldErrors } from '../action-state'

// Any signed-in user may change their own password. The passwords are read as typed (not trimmed) and are never
// part of the state that goes back to the form, whatever the outcome.
export async function changeOwnPasswordAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, user } = await beginAction()
  let result: Awaited<ReturnType<typeof doChangeOwnPassword>>
  try {
    result = await doChangeOwnPassword({ db, limits: loginLimits(), headers: await headers() }, user, {
      currentPassword: formRawText(formData, 'currentPassword'),
      newPassword: formRawText(formData, 'newPassword'),
      confirmPassword: formRawText(formData, 'confirmPassword'),
    })
  } catch (error) {
    return actionError(error, 'changing password')
  }
  if (!('session' in result)) return result

  // Changing the password ended every session, this one included; the new one replaces it in the browser.
  setSessionCookie(await cookies(), result.session.token, result.session.expiresAt)
  return { notice: PASSWORD_CHANGED_NOTICE }
}
