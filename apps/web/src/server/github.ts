import type { SourceConfig } from '@vpsm/core'
import { type Actor, type Db, type GithubRepository, type GithubStatus, requestGithubSync } from '@vpsm/db'
import type { ActionState } from './action-state'
import { assertAdmin } from './admin'
import { auditBestEffort } from './audit'

// The dashboard's side of the GitHub App. It never calls GitHub: the worker writes the repository list and the
// App's status to the database, the webhook endpoint records the last delivery, and this file only decides what
// the pages say about them and asks the worker for a sync.

export const SYNC_REQUESTED_NOTICE = 'Sync requested. The list updates within a minute.'

export type PushDeployNote = { tone: 'ok' | 'warning'; text: string }

/**
 * What the service page says about deploying on push, or null for a service without a source (nothing to push).
 * A push deploys the service only when the App is set up, the dashboard has the webhook secret to check deliveries
 * with (without it every delivery is a 503), and the App can read the repository; a public repository still builds
 * without the App, but a push never reaches it.
 */
export function pushDeployNote(i: {
  source: SourceConfig | null
  status: GithubStatus | null
  repository: GithubRepository | null
  /** Whether GITHUB_WEBHOOK_SECRET is set for the dashboard. */
  webhookConfigured: boolean
}): PushDeployNote | null {
  if (!i.source) return null
  if (!i.status) return { tone: 'warning', text: 'The GitHub App is not set up: pushes do not deploy this service.' }
  if (!i.webhookConfigured) {
    return {
      tone: 'warning',
      text: 'The dashboard has no webhook secret (GITHUB_WEBHOOK_SECRET): pushes do not deploy this service.',
    }
  }
  if (!i.repository) {
    return {
      tone: 'warning',
      text: `The GitHub App cannot read ${i.source.repo}: pushes do not deploy it, and it builds only if the repository is public.`,
    }
  }
  return { tone: 'ok', text: `Every push to ${i.source.branch} deploys this service.` }
}

/** Asks the worker to read the repositories the App can see again, and records github.sync. */
export async function doRequestGithubSync(db: Db, actor: Actor): Promise<ActionState> {
  assertAdmin(actor)
  await requestGithubSync(db)
  await auditBestEffort(db, { actorId: actor.id, action: 'github.sync', targetType: 'github' })
  return { notice: SYNC_REQUESTED_NOTICE }
}
