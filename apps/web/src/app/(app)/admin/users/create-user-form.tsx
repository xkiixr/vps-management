'use client'

import { useActionState } from 'react'
import { TextField } from '@/components/text-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { createUserAction, type PasswordState } from '@/server/actions/admin'
import { IssuedPasswordNotice } from './issued-password'

const initialState: PasswordState = {}

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, initialState)
  const errors = state.fieldErrors ?? {}
  // React empties the form once its action is done; what was typed comes back from the action when it was refused.
  const shown = { email: '', name: '', role: 'member', ...state.values }
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.issued && <IssuedPasswordNotice issued={state.issued} heading="Account created" />}
      <TextField
        name="email"
        label="Email"
        type="email"
        required
        placeholder="teammate@example.com"
        defaultValue={shown.email}
        error={errors.email}
      />
      <TextField name="name" label="Name" required defaultValue={shown.name} error={errors.name} />
      <div className="grid content-start gap-2">
        <Label htmlFor="role">Role</Label>
        <select
          id="role"
          name="role"
          defaultValue={shown.role}
          aria-invalid={errors.role ? true : undefined}
          aria-describedby={errors.role ? 'role-error' : 'role-hint'}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        {errors.role ? (
          <p id="role-error" className="text-sm text-destructive">
            {errors.role}
          </p>
        ) : (
          <p id="role-hint" className="text-sm text-muted-foreground">
            Admins manage users and system settings and see every project. Members see their own projects.
          </p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        A password is generated for the account and shown once, after it is created.
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </form>
  )
}
