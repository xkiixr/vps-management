import { type Actor, type Db, findDeploymentFor, readLogs } from '@vpsm/db'
import { isFinished, LOG_PAGE_SIZE, type LogsResponse } from '../lib/logs'

// The logic of the build-log route, apart from Next (cookies, Response), so that it can be tested against a
// database. A deployment the actor may not see is the same answer as one that does not exist.

export const AFTER_MESSAGE = 'after must be a whole number, 0 or more'

export type LogsResult =
  | { status: 200; body: LogsResponse }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } }

/** The position the caller already has: absent means the start; anything but plain digits is null. */
export function parseAfter(value: string | null): number | null {
  if (value === null) return 0
  if (!/^\d+$/.test(value)) return null
  const position = Number(value)
  return Number.isSafeInteger(position) ? position : null
}

/**
 * The next lines of a deployment's log after the line with id `after`. `finished` tells the caller to stop asking:
 * the deployment is over and this answer holds its last lines.
 */
export async function doReadLogs(db: Db, actor: Actor, deploymentId: string, after: string | null): Promise<LogsResult> {
  // The deployment (and with it its status) comes first and the actor's access is part of it. An outsider gets
  // the 404 whatever else is wrong with the request.
  const found = await findDeploymentFor(db, actor, deploymentId)
  if (!found) return { status: 404, body: { error: 'not found' } }
  const position = parseAfter(after)
  if (position === null) return { status: 400, body: { error: AFTER_MESSAGE } }

  // The status is read before the lines, not after: a status that is final means every line was written
  // already (the lines come first), so the lines read next are complete. The other way round, a deployment that
  // finished between the two reads would be reported finished with its last lines missing.
  const lines = await readLogs(db, found.deployment.id, position, LOG_PAGE_SIZE)
  return {
    status: 200,
    body: {
      lines,
      lastId: lines.at(-1)?.id ?? position,
      // A full page may not be the end of the log, whatever the status.
      finished: isFinished(found.deployment.status) && lines.length < LOG_PAGE_SIZE,
    },
  }
}
