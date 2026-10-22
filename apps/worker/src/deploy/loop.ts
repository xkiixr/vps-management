import { claimNextDeployment, DEPLOYMENTS_CHANNEL } from '@vpsm/db'
import { type PipelineDeps, runDeployment } from './pipeline'

/** Catches anything a missed notification (e.g. during a database reconnect) left in the queue. */
const POLL_INTERVAL_MS = 5000

export type DeployLoopDeps = PipelineDeps & {
  /** Subscribes to a Postgres NOTIFY channel; resolves with the unsubscribe function. */
  listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Runs queued deployments one at a time, oldest first: right away, whenever a deployment is enqueued
 * (NOTIFY) and every 5 seconds. Once `signal` aborts it stops listening and claiming; the returned
 * promise resolves when the deployment that was running at that moment (if any) has finished.
 */
export async function startDeployLoop(deps: DeployLoopDeps, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return

  // `busy` keeps drains from overlapping; a wake-up while busy sets `pending`, so the drain that is
  // running goes round once more instead of missing a deployment enqueued after its last empty claim.
  let busy = false
  let pending = false
  let draining: Promise<void> = Promise.resolve()

  const drainQueue = async () => {
    while (!signal.aborted) {
      const next = await claimNextDeployment(deps.db)
      if (!next) return
      await runDeployment(next.id, deps) // never throws
    }
  }

  const pump = async () => {
    busy = true
    try {
      while (pending && !signal.aborted) {
        pending = false
        try {
          await drainQueue()
        } catch (error) {
          console.error(`deploy loop: could not claim the next deployment: ${messageOf(error)}`)
        }
      }
    } finally {
      busy = false
    }
  }

  const wake = () => {
    if (signal.aborted) return
    pending = true
    if (!busy) draining = pump()
  }

  const unlisten = await deps.listen(DEPLOYMENTS_CHANNEL, wake)
  const poll = setInterval(wake, POLL_INTERVAL_MS)
  wake()

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  clearInterval(poll)
  await unlisten().catch((error) => console.error(`deploy loop: could not stop listening: ${messageOf(error)}`))
  await draining
}
