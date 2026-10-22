'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { type ActionState, deployAction, restartAction } from '@/server/actions/deployments'

const initialState: ActionState = {}

type Which = 'deploy' | 'restart'

/** The Deploy and Restart buttons above the deployments, with what became of the last one pressed next to them. */
export function DeployActions({
  projectName,
  serviceName,
  canRestart,
}: {
  projectName: string
  serviceName: string
  canRestart: boolean
}) {
  const [deployState, deployForm, deploying] = useActionState(deployAction.bind(null, projectName, serviceName), initialState)
  const [restartState, restartForm, restarting] = useActionState(restartAction.bind(null, projectName, serviceName), initialState)
  // Only the answer to the button pressed last is shown: an old refusal of one must not sit next to the other.
  const [last, setLast] = useState<Which | null>(null)
  const shown = last === 'deploy' ? deployState : last === 'restart' ? restartState : initialState
  const busy = deploying || restarting

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form action={deployForm} onSubmit={() => setLast('deploy')}>
        <Button type="submit" disabled={busy}>
          {deploying ? 'Queuing…' : 'Deploy'}
        </Button>
      </form>
      <form action={restartForm} onSubmit={() => setLast('restart')}>
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !canRestart}
          title={canRestart ? 'Deploy the running image again, without downtime' : 'Nothing is running to restart'}
        >
          {restarting ? 'Queuing…' : 'Restart'}
        </Button>
      </form>
      {shown.error && (
        <span role="alert" className="text-sm text-destructive">
          {shown.error}
        </span>
      )}
      {shown.notice && !busy && (
        <span role="status" className="text-sm text-muted-foreground">
          {shown.notice}
        </span>
      )}
    </div>
  )
}
