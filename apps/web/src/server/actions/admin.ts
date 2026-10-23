'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ActionState, PasswordState } from '../action-state'
import {
  CREATE_USER_FIELDS,
  doCreateUser,
  doResetPassword,
  doSaveResourceSettings,
  doSetDisabled,
  doSetRole,
  SETTINGS_FIELDS,
} from '../admin'
import { actionError } from '../errors'
import { formTexts } from '../form'
import { doRequestGithubSync } from '../github'
import { beginAdminAction } from '../guards'
import { clearSessionCookie } from '../session'

export type { ActionState, FieldErrors, IssuedPassword, PasswordState } from '../action-state'

const USERS_PATH = '/admin/users'
const SETTINGS_PATH = '/admin/settings'

// Every action here starts with beginAdminAction(): the same-origin check, then the admin check (a member gets
// the 404 page). The user ids and values bound to an action by its page (userId, role, disabled) come from the
// browser; the logic looks the user up and checks the value before it does anything.

// The new user's password comes back in the state, to be shown once. A form that was refused gets back what was
// typed, because React empties the form when its action is done.
export async function createUserAction(_previous: PasswordState, formData: FormData): Promise<PasswordState> {
  const { db, actor } = await beginAdminAction()
  let typed: Record<string, string> = {}
  let result: PasswordState
  try {
    typed = formTexts(formData, CREATE_USER_FIELDS)
    result = await doCreateUser(db, actor, typed)
  } catch (error) {
    return { ...actionError(error, 'creating user'), values: typed }
  }
  if (!result.issued) return { ...result, values: typed }
  revalidatePath(USERS_PATH)
  return result
}

// The user's id is bound to the action by the page: resetPasswordAction.bind(null, userId).
export async function resetPasswordAction(userId: string, _previous: PasswordState, _formData: FormData): Promise<PasswordState> {
  const { db, actor } = await beginAdminAction()
  let result: Awaited<ReturnType<typeof doResetPassword>>
  try {
    result = await doResetPassword(db, actor, userId)
  } catch (error) {
    return actionError(error, 'resetting password')
  }
  if (result.ownPassword) {
    // Resetting the password ended the admin's own sessions, this one included.
    clearSessionCookie(await cookies())
    redirect('/login')
  }
  return result
}

// The user's id and the new role are bound to the action by the page: setRoleAction.bind(null, userId, role).
export async function setRoleAction(userId: string, role: string, _previous: ActionState, _formData: FormData): Promise<ActionState> {
  const { db, actor } = await beginAdminAction()
  let result: Awaited<ReturnType<typeof doSetRole>>
  try {
    result = await doSetRole(db, actor, userId, role)
  } catch (error) {
    return actionError(error, 'changing role')
  }
  if (result.error) return result
  revalidatePath(USERS_PATH)
  // A member no longer has the admin pages; the page they are on would be a 404.
  if (result.demotedSelf) redirect('/')
  return result
}

// The user's id and the wanted state are bound to the action by the page: setDisabledAction.bind(null, userId, true).
export async function setDisabledAction(
  userId: string,
  disabled: boolean,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAdminAction()
  let result: Awaited<ReturnType<typeof doSetDisabled>>
  try {
    result = await doSetDisabled(db, actor, userId, disabled)
  } catch (error) {
    return actionError(error, 'changing account state')
  }
  if (result.error) return result
  revalidatePath(USERS_PATH)
  if (result.disabledSelf) {
    // Disabling the account ended the admin's own sessions, this one included.
    clearSessionCookie(await cookies())
    redirect('/login')
  }
  return result
}

export async function saveResourceSettingsAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await beginAdminAction()
  let typed: Record<string, string> = {}
  let result: ActionState
  try {
    typed = formTexts(formData, SETTINGS_FIELDS)
    result = await doSaveResourceSettings(db, actor, typed)
  } catch (error) {
    return { ...actionError(error, 'saving settings'), values: typed }
  }
  if (result.error || result.fieldErrors) return { ...result, values: typed }
  revalidatePath(SETTINGS_PATH)
  return result
}

// Nothing is bound to this action and the form has no fields: the worker reads the repositories again and the
// page shows the new list on a later visit (it is read fresh on every request), so there is nothing to refresh.
export async function requestGithubSyncAction(_previous: ActionState, _formData: FormData): Promise<ActionState> {
  const { db, actor } = await beginAdminAction()
  try {
    return await doRequestGithubSync(db, actor)
  } catch (error) {
    return actionError(error, 'requesting github sync')
  }
}
