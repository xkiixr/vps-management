import { eq } from 'drizzle-orm'
import { deployments } from '@vpsm/db'
import type { PipelineDeps } from '../deploy/pipeline'
import { isCrashFinal, markCrashed, reconcileLiveDeployments } from './reconcile'

export { isCrashFinal }

/** Lets Docker apply its restart policy before the container's state is read. */
const SETTLE_MS = 2000
const RESUBSCRIBE_DELAY_MS = 5000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Marks the deployment of a container that just died CRASHED, if Docker has given up restarting it and
 * the deployment is still the live (SUCCESS) one. Never throws.
 */
export async function handleContainerDeath(deps: PipelineDeps, name: string, signal: AbortSignal): Promise<void> {
  try {
    await deps.sleep(SETTLE_MS)
    if (signal.aborted) return
    const state = await deps.docker.state(name)
    if (!isCrashFinal(state)) return

    const deploymentId = (await deps.docker.listManaged()).find((c) => c.name === name)?.deploymentId
    if (!deploymentId) return
    const [deployment] = await deps.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
    if (deployment?.status !== 'SUCCESS') return

    await markCrashed(deps.db, deploymentId, `container exited with code ${state.exitCode}`)
  } catch (error) {
    console.error(`crash monitor: could not check container ${name}: ${messageOf(error)}`)
  }
}

/**
 * Watches managed containers for exits until `signal` aborts. Docker's event stream does not reconnect
 * by itself, so after it breaks the monitor subscribes again 5 seconds later. Every (re)subscription is
 * followed by a reconcile, which catches containers that died while nothing was listening.
 */
export function startCrashMonitor(deps: PipelineDeps, signal: AbortSignal): void {
  if (signal.aborted) return
  // Bumped whenever a subscription ends, so a late error from an old stream is ignored.
  let generation = 0
  let unsubscribe: (() => void) | undefined

  const end = () => {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
  }

  const subscribe = () => {
    const mine = ++generation
    const unsub = deps.docker.onContainerDie(
      (name) => void handleContainerDeath(deps, name, signal),
      (error) => {
        if (mine !== generation) return
        end()
        if (signal.aborted) return
        console.error(
          `crash monitor: docker event stream failed (${messageOf(error)}); resubscribing in ${RESUBSCRIBE_DELAY_MS / 1000}s`,
        )
        void deps.sleep(RESUBSCRIBE_DELAY_MS).then(() => {
          if (!signal.aborted) subscribe()
        })
      },
    )
    // The stream may already have failed while subscribing.
    if (mine !== generation) return unsub()
    unsubscribe = unsub
    reconcileLiveDeployments(deps, { startStopped: false }).catch((error) => {
      console.error(`crash monitor: could not reconcile live deployments: ${messageOf(error)}`)
    })
  }

  signal.addEventListener('abort', end, { once: true })
  subscribe()
}
