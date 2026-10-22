'use client'

import { useActionState } from 'react'
import { TextField } from '@/components/text-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { type ActionState, saveResourceSettingsAction } from '@/server/actions/admin'

const initialState: ActionState = {}

/** The limits as the form shows them: the value in force, and whether it is the default (nothing saved yet). */
export type ResourceSettingsView = {
  memoryBudgetMb: string
  maxServiceMemoryMb: string
  memoryBudgetIsDefault: boolean
  maxServiceMemoryIsDefault: boolean
}

export function ResourceSettingsForm({ current, minServiceMb }: { current: ResourceSettingsView; minServiceMb: number }) {
  const [state, formAction, pending] = useActionState(saveResourceSettingsAction, initialState)
  const errors = state.fieldErrors ?? {}
  // React empties the form once its action is done; what was typed comes back from the action when it was
  // refused, and otherwise the saved values (which the page has reloaded by then) are shown.
  const shown = { memoryBudgetMb: current.memoryBudgetMb, maxServiceMemoryMb: current.maxServiceMemoryMb, ...state.values }
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
        name="memoryBudgetMb"
        label="Memory budget (MB)"
        required
        inputMode="numeric"
        defaultValue={shown.memoryBudgetMb}
        error={errors.memoryBudgetMb}
        hint={`The RAM all deployed apps may use together. A deployment that does not fit is refused.${
          current.memoryBudgetIsDefault ? ' (default: not saved here yet, so the server configuration applies)' : ''
        }`}
      />
      <TextField
        name="maxServiceMemoryMb"
        label="Most memory per service (MB)"
        required
        inputMode="numeric"
        defaultValue={shown.maxServiceMemoryMb}
        error={errors.maxServiceMemoryMb}
        hint={`The most one service may be given: from ${minServiceMb} MB up to the memory budget.${
          current.maxServiceMemoryIsDefault ? ' (default: not saved here yet, so the server configuration applies)' : ''
        }`}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  )
}
