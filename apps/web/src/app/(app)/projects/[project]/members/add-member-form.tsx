'use client'

import { useActionState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

export function AddMemberForm({ action }: { action: FormAction<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, initialState)
  const emailError = state.fieldErrors?.email
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="off"
          placeholder="teammate@example.com"
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'email-error' : undefined}
        />
        {emailError && (
          <p id="email-error" className="text-sm text-destructive">
            {emailError}
          </p>
        )}
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add member'}
        </Button>
      </div>
    </form>
  )
}
