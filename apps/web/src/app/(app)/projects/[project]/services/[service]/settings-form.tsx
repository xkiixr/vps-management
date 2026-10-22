'use client'

import { useActionState } from 'react'
import { TextField } from '@/components/text-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { ActionState, FormAction } from '@/server/action-state'

const initialState: ActionState = {}

/** The settings of a service as the form shows them: all text, none of it secret. */
export type ServiceSettings = {
  repo: string
  branch: string
  rootDirectory: string
  healthcheckPath: string
  port: string
  memoryLimitMB: string
  startCommand: string
}

export function SettingsForm({
  current,
  maxMemoryMb,
  action,
}: {
  current: ServiceSettings
  maxMemoryMb: number
  action: FormAction<ActionState>
}) {
  const [state, formAction, pending] = useActionState(action, initialState)
  const errors = state.fieldErrors ?? {}
  // React empties the form once its action is done; what was typed comes back from the action when it was
  // refused, and otherwise the saved settings (which the page has reloaded by then) are shown.
  const shown = { ...current, ...state.values }
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
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="repo"
          label="Repository"
          required
          placeholder="owner/name"
          defaultValue={shown.repo}
          error={errors.repo}
          hint="A GitHub repository, as owner/name."
        />
        <TextField
          name="branch"
          label="Branch"
          required
          placeholder="main"
          defaultValue={shown.branch}
          error={errors.branch}
          hint="Deploys use this branch. Automatic deploys on push come with the GitHub integration."
        />
        <TextField
          name="rootDirectory"
          label="Root directory"
          placeholder="services/api"
          defaultValue={shown.rootDirectory}
          error={errors.rootDirectory}
          hint="The folder of the repository to build. Empty means the whole repository."
        />
        <TextField
          name="healthcheckPath"
          label="Healthcheck path"
          placeholder="/health"
          defaultValue={shown.healthcheckPath}
          error={errors.healthcheckPath}
          hint="Must answer successfully before a deployment goes live. Empty means a connection to the port is enough."
        />
        <TextField
          name="port"
          label="Port"
          required
          inputMode="numeric"
          defaultValue={shown.port}
          error={errors.port}
          hint="The port the app listens on."
        />
        <TextField
          name="memoryLimitMB"
          label="Memory limit (MB)"
          required
          inputMode="numeric"
          defaultValue={shown.memoryLimitMB}
          error={errors.memoryLimitMB}
          hint={`From 6 to ${maxMemoryMb}.`}
        />
        <TextField
          name="startCommand"
          label="Start command"
          placeholder="node server.js"
          defaultValue={shown.startCommand}
          error={errors.startCommand}
          hint="Empty means what the build detects."
        />
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {/* The first submit button is what Enter in a field presses: saving and deploying is the default. */}
        <Button type="submit" name="intent" value="save-deploy" disabled={pending}>
          {pending ? 'Saving…' : 'Save and deploy'}
        </Button>
        <div className="grid max-w-xs gap-1.5">
          <Button type="submit" name="intent" value="save-only" variant="outline" disabled={pending}>
            Save without deploying
          </Button>
          <p className="text-sm text-muted-foreground">
            The running deployment is left as it is. The next deploy will include these settings.
          </p>
        </div>
      </div>
    </form>
  )
}
