'use client'

import { useActionState } from 'react'
import { TextField } from '@/components/text-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { type ActionState, changeOwnPasswordAction } from '@/server/actions/account'

const initialState: ActionState = {}

// The same limits the server enforces (MIN/MAX_PASSWORD_LENGTH of @vpsm/db); the server is what decides.
const MIN_LENGTH = 12
const MAX_LENGTH = 1024

// Nothing typed here is ever sent back by the action, so React emptying the form after it is done is all there is
// to forget: the passwords are not kept in state either.
export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, initialState)
  const errors = state.fieldErrors ?? {}
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.notice && (
        <Alert role="status">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      )}
      <TextField
        name="currentPassword"
        label="Current password"
        type="password"
        required
        autoComplete="current-password"
        maxLength={MAX_LENGTH}
        error={errors.currentPassword}
      />
      <TextField
        name="newPassword"
        label="New password"
        type="password"
        required
        autoComplete="new-password"
        minLength={MIN_LENGTH}
        maxLength={MAX_LENGTH}
        error={errors.newPassword}
        hint={`At least ${MIN_LENGTH} characters, and not the same as the current one.`}
      />
      <TextField
        name="confirmPassword"
        label="New password again"
        type="password"
        required
        autoComplete="new-password"
        minLength={MIN_LENGTH}
        maxLength={MAX_LENGTH}
        error={errors.confirmPassword}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  )
}
