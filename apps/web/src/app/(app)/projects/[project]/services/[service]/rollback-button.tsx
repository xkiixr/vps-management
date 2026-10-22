'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

/** The Rollback button of one row of the deployments table: deploys that deployment's image again. */
export function RollbackButton({
  label,
  action,
}: {
  /** What the deployment is called, for screen readers: there is one of these buttons in every row. */
  label: string
  action: FormAction<ActionState>
}) {
  const [state, formAction, pending] = useActionState(action, initialState)
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={`Roll back to deployment ${label}`}>
        {pending ? 'Queuing…' : 'Rollback'}
      </Button>
      {state.error && (
        <span role="alert" className="max-w-48 text-right text-xs text-destructive">
          {state.error}
        </span>
      )}
      {state.notice && !pending && (
        <span role="status" className="text-xs text-muted-foreground">
          {state.notice}
        </span>
      )}
    </form>
  )
}
