'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import type { ActionState, FormAction, PasswordState } from '@/server/action-state'
import { IssuedPasswordNotice } from './issued-password'

const initialState: ActionState = {}
const initialPasswordState: PasswordState = {}

/**
 * What an admin can do to one user: change the role, disable or enable, and reset the password. The password is
 * shown under the buttons, once. An admin's own row has no reset: it would end their own session with a password
 * they could not see, so they change it on the Account page instead. Plain strings and the actions, already bound
 * to this user by the page, come in.
 */
export function UserActions({
  email,
  role,
  disabled,
  isSelf,
  setRole,
  setDisabled,
  resetPassword,
}: {
  email: string
  role: 'admin' | 'member'
  disabled: boolean
  isSelf: boolean
  /** Gives the user the other role than `role`. */
  setRole: FormAction<ActionState>
  /** Disables the user, or enables them when `disabled`. */
  setDisabled: FormAction<ActionState>
  resetPassword: FormAction<PasswordState>
}) {
  const nextRole = role === 'admin' ? 'member' : 'admin'
  const [roleState, roleForm, changingRole] = useActionState(setRole, initialState)
  const [disabledState, disabledForm, changingState] = useActionState(setDisabled, initialState)
  const [resetState, resetForm, resetting] = useActionState(resetPassword, initialPasswordState)
  const errors = [roleState.error, disabledState.error, resetState.error].filter((error) => error !== undefined)

  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <form action={roleForm}>
          <Button type="submit" variant="outline" size="sm" disabled={changingRole} aria-label={`Make ${email} ${nextRole === 'admin' ? 'an admin' : 'a member'}`}>
            {nextRole === 'admin' ? 'Make admin' : 'Make member'}
          </Button>
        </form>
        <form action={disabledForm}>
          <Button type="submit" variant="outline" size="sm" disabled={changingState} aria-label={`${disabled ? 'Enable' : 'Disable'} ${email}`}>
            {disabled ? 'Enable' : 'Disable'}
          </Button>
        </form>
        {isSelf ? (
          <Button asChild variant="ghost" size="sm">
            <Link href="/account">Change your password</Link>
          </Button>
        ) : (
          <form action={resetForm}>
            <Button type="submit" variant="outline" size="sm" disabled={resetting} aria-label={`Reset the password of ${email}`}>
              {resetting ? 'Resetting…' : 'Reset password'}
            </Button>
          </form>
        )}
      </div>
      {errors.map((error) => (
        <p key={error} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ))}
      {resetState.issued && (
        <div className="w-full max-w-md text-left">
          <IssuedPasswordNotice issued={resetState.issued} heading="Password reset" />
        </div>
      )}
    </div>
  )
}
