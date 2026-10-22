'use client'

import { useActionState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/text-field'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

export function NewServiceForm({ maxMemoryMb, action }: { maxMemoryMb: number; action: FormAction<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, initialState)
  const errors = state.fieldErrors ?? {}
  // React empties the form once its action is done; what was typed comes back from the action when it failed.
  const typed = state.values ?? {}
  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Name"
          required
          maxLength={30}
          placeholder="web"
          defaultValue={typed.name ?? ''}
          error={errors.name}
          hint="Lowercase letters, digits and hyphens, starting with a letter. It becomes part of the service's address."
        />
        <TextField
          name="repo"
          label="Repository"
          required
          placeholder="owner/name"
          defaultValue={typed.repo ?? ''}
          error={errors.repo}
          hint="A GitHub repository, as owner/name."
        />
        <TextField
          name="branch"
          label="Branch"
          placeholder="main"
          defaultValue={typed.branch ?? ''}
          error={errors.branch}
          hint="Empty means main. Deploys use this branch. Automatic deploys on push come with the GitHub integration."
        />
        <TextField
          name="rootDirectory"
          label="Root directory"
          placeholder="services/api"
          defaultValue={typed.rootDirectory ?? ''}
          error={errors.rootDirectory}
          hint="The folder of the repository to build. Empty means the whole repository."
        />
        <TextField
          name="healthcheckPath"
          label="Healthcheck path"
          placeholder="/health"
          defaultValue={typed.healthcheckPath ?? ''}
          error={errors.healthcheckPath}
          hint="Must answer successfully before a deployment goes live. Empty means a connection to the port is enough."
        />
        <TextField
          name="port"
          label="Port"
          inputMode="numeric"
          placeholder="8080"
          defaultValue={typed.port ?? ''}
          error={errors.port}
          hint="The port the app listens on. Empty means 8080."
        />
        <TextField
          name="memoryLimitMB"
          label="Memory limit (MB)"
          inputMode="numeric"
          placeholder="512"
          defaultValue={typed.memoryLimitMB ?? ''}
          error={errors.memoryLimitMB}
          hint={`From 6 to ${maxMemoryMb}. Empty means 512.`}
        />
        <TextField
          name="startCommand"
          label="Start command"
          placeholder="node server.js"
          defaultValue={typed.startCommand ?? ''}
          error={errors.startCommand}
          hint="Empty means what the build detects."
        />
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create and deploy'}
        </Button>
      </div>
    </form>
  )
}
