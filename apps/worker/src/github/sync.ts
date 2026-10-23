import { GITHUB_SYNC_CHANNEL, replaceGithubRepositories, setGithubStatus, type Db, type GithubStatus } from '@vpsm/db'
import type { DeployLoopDeps } from '../deploy/loop'
import type { GithubAppClient } from './app-client'

/** Catches a sync request (NOTIFY) that was missed, and picks up repositories added to the app on GitHub meanwhile. */
const SYNC_INTERVAL_MS = 10 * 60_000
/** What is stored of a failure: the first line of its message, cut here. The dashboard shows it to an admin. */
const MAX_ERROR_LENGTH = 500

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The first line of the message, at most MAX_ERROR_LENGTH long. A driver error carries the parameters of the failed
 * statement on the lines after the first, and those are not for the status (nor for the log).
 */
function reasonOf(error: unknown): string {
  let line = (messageOf(error).split(/\r?\n/)[0] ?? '').trim().slice(0, MAX_ERROR_LENGTH)
  // Half a surrogate pair is not valid text: jsonb refuses it, and the status would not be stored at all.
  if (/[\ud800-\udbff]$/.test(line)) line = line.slice(0, -1)
  return line || 'unknown error'
}

/**
 * Lists what the GitHub App can read and stores it for the dashboard, which never calls GitHub itself: the
 * repositories (replaced as a whole) and the status of the App with the repository count per installation. When
 * GitHub or the database fails the error is stored as the status instead and the previous repositories stay, so
 * an outage does not empty the dashboard's repository picker. Never throws; the status is returned as it was
 * meant to be stored, even when storing it failed (that is logged).
 */
export async function syncGithub(
  db: Db,
  client: GithubAppClient,
  now: () => Date = () => new Date(),
): Promise<GithubStatus> {
  let status: GithubStatus
  try {
    const { slug } = await client.app()
    const { installations, repositories } = await client.listRepositories()
    await replaceGithubRepositories(db, repositories)
    const counts = new Map<number, number>()
    for (const repository of repositories) {
      counts.set(repository.installationId, (counts.get(repository.installationId) ?? 0) + 1)
    }
    status = {
      ok: true,
      checkedAt: now().toISOString(),
      appSlug: slug,
      installations: installations.map(({ id, account }) => ({ account, repositories: counts.get(id) ?? 0 })),
    }
  } catch (error) {
    const reason = reasonOf(error)
    console.error(`github sync: ${reason}`)
    status = { ok: false, checkedAt: now().toISOString(), error: reason }
  }
  try {
    await setGithubStatus(db, status)
  } catch (error) {
    console.error(`github sync: could not store the status: ${reasonOf(error)}`)
  }
  return status
}

/**
 * Runs `syncGithub` right away, whenever the dashboard asks for it (NOTIFY on the sync channel) and every
 * `intervalMs`, one sync at a time. A request that arrives during a sync only sets a flag, which makes the
 * sync in progress go round once more when it ends, however many requests there were. It is separate from the
 * deploy loop: a slow or failing GitHub never delays a deployment. Once `signal` aborts it stops listening and
 * starting syncs; the returned promise resolves when the sync that was running at that moment (if any) has
 * finished.
 */
export async function startGithubSync(
  deps: { db: Db; client: GithubAppClient; listen: DeployLoopDeps['listen'] },
  signal: AbortSignal,
  intervalMs = SYNC_INTERVAL_MS,
): Promise<void> {
  if (signal.aborted) return

  // `busy` keeps syncs from overlapping. The flag is cleared before a sync starts, so a request that arrives
  // meanwhile (even while its status is being written) leads to another one.
  let busy = false
  let requested = false
  let running: Promise<void> = Promise.resolve()

  const pump = async () => {
    busy = true
    try {
      while (requested && !signal.aborted) {
        requested = false
        await syncGithub(deps.db, deps.client) // never throws
      }
    } finally {
      busy = false
    }
  }

  const request = () => {
    if (signal.aborted) return
    requested = true
    if (!busy) running = pump()
  }

  // Listening comes first, so a request made during the first sync is not missed.
  const unlisten = await deps.listen(GITHUB_SYNC_CHANNEL, request)
  const timer = setInterval(request, intervalMs)
  request()

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  clearInterval(timer)
  await unlisten().catch((error) => console.error(`github sync: could not stop listening: ${messageOf(error)}`))
  await running
}
