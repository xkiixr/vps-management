'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { type ActionState, removeMemberAction } from '@/server/actions/projects'

const initialState: ActionState = {}

export function RemoveMemberForm({ projectName, userId, label }: { projectName: string; userId: string; label: string }) {
  const [state, formAction, pending] = useActionState(removeMemberAction.bind(null, projectName, userId), initialState)
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
