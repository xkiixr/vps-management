import type { DeploymentStatus } from '@vpsm/core'

// What the build-log route and the log viewer agree on. No server code in here: the viewer is a client component.

/** The most lines one answer of the log route (and the first page of the log page) holds. */
export const LOG_PAGE_SIZE = 2000
/** The most lines the viewer keeps in the page; older ones are dropped, so a long build cannot freeze the tab. */
export const MAX_RENDERED_LINES = 5000
/** How long the viewer waits before asking for new lines while the deployment has not finished. */
export const LOG_POLL_INTERVAL_MS = 3000

export type LogLine = { id: number; phase: 'build' | 'deploy'; line: string }

/** What `GET /api/deployments/<id>/logs?after=<n>` answers. `lastId` is `after` itself when there is nothing new. */
export type LogsResponse = { lines: LogLine[]; lastId: number; finished: boolean }

// After these the log is complete once the worker has closed it (`logsClosedAt`): the status is set before the
// last lines are written (SUCCESS before the lines about going live, FAILED before the failure line), so the
// status alone does not say that nothing more will come.
const OVER_STATUSES: readonly DeploymentStatus[] = ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED']

/**
 * True when no more log lines will be written, and a reader of the log may stop asking: the worker closed the log
 * of a deployment that is over, or the deployment never ran (SKIPPED: a newer one replaced it while it waited).
 */
export function isFinished(deployment: { status: DeploymentStatus; logsClosedAt: Date | null }): boolean {
  if (deployment.status === 'SKIPPED') return true
  return OVER_STATUSES.includes(deployment.status) && deployment.logsClosedAt !== null
}

/** Why the viewer is not getting new lines: the answer will not change (`signed-out`, `gone`) or it may (`offline`). */
export type LogProblem = 'signed-out' | 'gone' | 'offline'

/** What the line above the log says about whether it is being followed. */
export function followingStatus(finished: boolean, problem: LogProblem | null): string {
  if (finished) return 'Finished. No more lines will come.'
  if (problem === 'signed-out' || problem === 'gone') return 'Stopped following the log.'
  if (problem === 'offline') return 'Could not reach the server. Trying again…'
  return 'Following the log. New lines show up every 3 seconds.'
}

/** What the viewer tells the reader when it stopped for good; null while it is still trying. */
export function stoppedReason(problem: LogProblem | null): string | null {
  if (problem === 'signed-out') return 'Your session has ended. Sign in again to keep following the log.'
  if (problem === 'gone') return 'This deployment is no longer available.'
  return null
}

/**
 * `current` followed by the lines of `incoming` that come after it, keeping only the last `cap` lines. `dropped`
 * is how many lines were cut off the front, for the "showing the last N lines" note. A line that is not newer
 * than the last one held (an answer that arrived twice) is ignored.
 */
export function appendLines(
  current: readonly LogLine[],
  incoming: readonly LogLine[],
  cap: number = MAX_RENDERED_LINES,
): { lines: LogLine[]; dropped: number } {
  const lastId = current.at(-1)?.id ?? -1
  const joined = [...current, ...incoming.filter((line) => line.id > lastId)]
  const dropped = Math.max(0, joined.length - cap)
  return { lines: dropped === 0 ? joined : joined.slice(dropped), dropped }
}
