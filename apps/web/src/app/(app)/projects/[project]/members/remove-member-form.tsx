'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

export function RemoveMemberForm({ label, action }: { label: string; action: FormAction<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, initialState)
  return (
    <form action={formAction} className="flex items-center justify-end gap-3">
      {state.error && (
        <span role="alert" className="text-sm text-destructive">
          {state.error}
        </span>
      )}
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={`Remove ${label}`}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
    </form>
  )
}
