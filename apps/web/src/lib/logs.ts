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

// No more log lines are written once a deployment is in one of these.
const FINISHED_STATUSES: readonly DeploymentStatus[] = ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']

export function isFinished(status: DeploymentStatus): boolean {
  return FINISHED_STATUSES.includes(status)
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
