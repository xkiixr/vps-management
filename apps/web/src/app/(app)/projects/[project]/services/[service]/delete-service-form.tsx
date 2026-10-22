'use client'

import { useActionState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type ActionState, deleteServiceAction } from '@/server/actions/services'

const initialState: ActionState = {}

export function DeleteServiceForm({ projectName, serviceName }: { projectName: string; serviceName: string }) {
  const [state, formAction, pending] = useActionState(deleteServiceAction.bind(null, projectName, serviceName), initialState)
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor="confirm">
          Type <span className="font-mono font-semibold">{serviceName}</span> to confirm
        </Label>
        <Input id="confirm" name="confirm" required autoComplete="off" spellCheck={false} />
      </div>
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? 'Deleting…' : 'Delete service'}
        </Button>
      </div>
    </form>
  )
}
