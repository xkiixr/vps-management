'use client'

import { useActionState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

/** The "Sync now" button. The form has no fields: the worker is only told to read the repositories again. */
export function SyncForm({ action }: { action: FormAction<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, initialState)
  return (
    <form action={formAction} className="grid gap-3">
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
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Requesting…' : 'Sync now'}
        </Button>
      </div>
    </form>
  )
}
