'use client'

import { useActionState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type ActionState, createProjectAction } from '@/server/actions/projects'

const initialState: ActionState = {}

export function CreateProjectForm() {
  const [state, formAction, pending] = useActionState(createProjectAction, initialState)
  const nameError = state.fieldErrors?.name
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={30}
          autoComplete="off"
          spellCheck={false}
          placeholder="my-project"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'name-error' : 'name-hint'}
        />
        {nameError ? (
          <p id="name-error" className="text-sm text-destructive">
            {nameError}
          </p>
        ) : (
          <p id="name-hint" className="text-sm text-muted-foreground">
            Lowercase letters, digits and hyphens, starting with a letter. It becomes part of your apps&apos; addresses.
          </p>
        )}
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </form>
  )
}
