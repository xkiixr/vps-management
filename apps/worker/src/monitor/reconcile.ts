import { and, eq, isNotNull } from 'drizzle-orm'
import { type Db, deployments, InvalidTransitionError, setDeploymentStatus } from '@vpsm/db'
import type { PipelineDeps } from '../deploy/pipeline'
import type { ContainerState } from '../runtime/docker-runtime'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** True once Docker will not restart the container again (under `on-failure` it never restarts a clean exit). */
export function isCrashFinal(s: ContainerState): boolean {
  return (
    !s.running &&
    !s.restarting &&
    (s.restartPolicy === 'no' ||
      (s.restartPolicy === 'on-failure' && (s.exitCode === 0 || s.restartCount >= s.maxRetries)))
  )
}

/**
 * Moves a live deployment to CRASHED. Returns false, without throwing, when it is no longer SUCCESS
 * (replaced or already marked in the meantime).
 */
export async function markCrashed(db: Db, deploymentId: string, failureReason: string): Promise<boolean> {
  try {
    await setDeploymentStatus(db, deploymentId, 'CRASHED', { failureReason })
    return true
  } catch (error) {
    if (error instanceof InvalidTransitionError) return false
    throw error
  }
}

/**
 * Compares every live (SUCCESS) deployment with its container, for deaths no Docker event reported (the
 * worker was not running or not subscribed). A missing container is CRASHED. A stopped one is started
 * again when `startStopped` (at worker startup, e.g. after a host reboot), or else CRASHED once Docker
 * has given up on it. Running and restarting containers, and every other deployment, are left alone.
 */
export async function reconcileLiveDeployments(
  deps: PipelineDeps,
  opts: { startStopped: boolean },
): Promise<{ crashed: number; started: number }> {
  const { db, docker } = deps
  const live = await db
    .select({ id: deployments.id, containerName: deployments.containerName })
    .from(deployments)
    .where(and(eq(deployments.status, 'SUCCESS'), isNotNull(deployments.containerName)))

  let crashed = 0
  let started = 0
  const crash = async (id: string, reason: string) => {
    if (await markCrashed(db, id, reason)) crashed++
  }
  for (const { id, containerName } of live) {
    const name = containerName!
    const state = await docker.state(name)
    if (!state.exists) {
      await crash(id, 'container disappeared')
    } else if (state.running || state.restarting) {
      continue
    } else if (opts.startStopped) {
      try {
        await docker.restart(name)
        started++
      } catch (error) {
        await crash(id, `could not restart container: ${messageOf(error)}`)
      }
    } else if (isCrashFinal(state)) {
      await crash(id, `container exited with code ${state.exitCode}`)
    }
  }
  return { crashed, started }
}
