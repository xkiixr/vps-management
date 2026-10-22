import { CLEANUP_CHANNEL, claimNextDeployment, DEPLOYMENTS_CHANNEL, purgeExpiredSessions } from '@vpsm/db'
import { sweepOrphans } from '../maintenance/sweep'
import { type PipelineDeps, runDeployment } from './pipeline'

/** Catches anything a missed notification (e.g. during a database reconnect) left in the queue. */
const POLL_INTERVAL_MS = 5000
/**
 * Catches deletions whose notification was missed, and anything an earlier sweep could not remove. Expired
 * dashboard sessions are purged at the same time.
 */
const SWEEP_INTERVAL_MS = 60_000

export type DeployLoopDeps = PipelineDeps & {
  /** Subscribes to a Postgres NOTIFY channel; resolves with the unsubscribe function. */
  listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Runs queued deployments one at a time, oldest first: right away, whenever a deployment is enqueued
 * (NOTIFY) and every 5 seconds. Between two deployments, never during one, it runs the orphan sweep when
 * one was requested: by a NOTIFY on the cleanup channel (a service or project was deleted) or every 60
 * seconds. The sweep would take the container of a running deployment for an orphan (it is not SUCCESS
 * yet), and a deployment claimed while a sweep runs waits for it. Each sweep is followed by a purge of the
 * dashboard's expired sessions (best effort: a failure is logged and the loop carries on). Once `signal`
 * aborts it stops listening and claiming; the returned promise resolves when the deployment or sweep that
 * was running at that moment (if any) has finished.
 */
export async function startDeployLoop(deps: DeployLoopDeps, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return

  // `busy` keeps runs from overlapping; a request while busy only sets its flag, which the run in progress
  // picks up before it ends. A flag is cleared before its work starts, so a request that arrives meanwhile
  // (e.g. a deployment enqueued just after the claim found the queue empty) is not lost.
  let busy = false
  let deployRequested = false
  let sweepRequested = false
  let running: Promise<void> = Promise.resolve()

  const sweep = async () => {
    try {
      const { containers, networks, images } = await sweepOrphans(deps)
      // Quiet unless something was removed: it runs every minute.
      if (containers + networks + images > 0) {
        console.log(`orphan sweep: removed ${containers} container(s), ${networks} network(s), ${images} image(s)`)
      }
    } catch (error) {
      console.error(`orphan sweep: ${messageOf(error)}`)
    }
  }

  // An expired session is refused anyway (resolveSession checks expires_at); this only keeps the table small.
  const purgeSessions = async () => {
    try {
      const purged = await purgeExpiredSessions(deps.db)
      if (purged > 0) console.log(`session purge: removed ${purged} expired dashboard session(s)`)
    } catch (error) {
      console.error(`session purge: ${messageOf(error)}`)
    }
  }

  /** Runs the oldest queued deployment; false when there was none or it could not be claimed. */
  const deployNext = async (): Promise<boolean> => {
    let next
    try {
      next = await claimNextDeployment(deps.db)
    } catch (error) {
      console.error(`deploy loop: could not claim the next deployment: ${messageOf(error)}`)
      return false
    }
    if (!next) return false
    await runDeployment(next.id, deps) // never throws
    return true
  }

  const pump = async () => {
    busy = true
    try {
      while (!signal.aborted) {
        if (sweepRequested) {
          sweepRequested = false
          await sweep()
          await purgeSessions()
        } else if (deployRequested) {
          deployRequested = false
          // The queue may hold more: go round again, after a sweep requested in the meantime.
          if (await deployNext()) deployRequested = true
        } else {
          return
        }
      }
    } finally {
      busy = false
    }
  }

  const request = (kind: 'deploy' | 'sweep') => {
    if (signal.aborted) return
    if (kind === 'deploy') deployRequested = true
    else sweepRequested = true
    if (!busy) running = pump()
  }
  const wake = () => request('deploy')
  const requestSweep = () => request('sweep')

  const unlistenDeployments = await deps.listen(DEPLOYMENTS_CHANNEL, wake)
  let unlistenCleanup: () => Promise<void>
  try {
    unlistenCleanup = await deps.listen(CLEANUP_CHANNEL, requestSweep)
  } catch (error) {
    await unlistenDeployments().catch(() => undefined)
    throw error
  }
  const poll = setInterval(wake, POLL_INTERVAL_MS)
  const sweepTimer = setInterval(requestSweep, SWEEP_INTERVAL_MS)
  wake()

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  clearInterval(poll)
  clearInterval(sweepTimer)
  for (const unlisten of [unlistenDeployments, unlistenCleanup]) {
    await unlisten().catch((error) => console.error(`deploy loop: could not stop listening: ${messageOf(error)}`))
  }
  await running
}
