import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from './client'
import { githubRepositories, type GithubRepository, projects, serviceInstances, services, settings } from './schema'

// The web panel NOTIFYs this when an admin asks for a sync; the worker lists the App's repositories when it hears it.
export const GITHUB_SYNC_CHANNEL = 'vpsm_github_sync'

// Keys of the `settings` rows the worker (status) and the webhook endpoint (last delivery) write without a user.
export const GITHUB_KEYS = { status: 'githubStatus', lastWebhook: 'githubLastWebhook' } as const

// Rows per INSERT, to stay far below the 65535 bind parameters Postgres allows in one statement.
const REPOSITORY_INSERT_BATCH_SIZE = 1000

export type GithubRepositoryInput = {
  id: number
  fullName: string
  defaultBranch: string
  private: boolean
  installationId: number
}

// Swaps the whole list in one transaction, so a reader sees the old list or the new one, never half of each. A list
// that cannot be stored (such as two names that differ only in letter case) leaves the old one in place.
export async function replaceGithubRepositories(db: Db, repos: GithubRepositoryInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(githubRepositories)
    for (let start = 0; start < repos.length; start += REPOSITORY_INSERT_BATCH_SIZE) {
      await tx.insert(githubRepositories).values(repos.slice(start, start + REPOSITORY_INSERT_BATCH_SIZE))
    }
  })
}

export async function listGithubRepositories(db: Db): Promise<GithubRepository[]> {
  return db
    .select()
    .from(githubRepositories)
    .orderBy(asc(sql`lower(${githubRepositories.fullName})`))
}

export async function findGithubRepository(db: Db, fullName: string): Promise<GithubRepository | null> {
  const [repository] = await db
    .select()
    .from(githubRepositories)
    .where(sql`lower(${githubRepositories.fullName}) = lower(${fullName})`)
  return repository ?? null
}

export type PushTarget = { instanceId: string; projectName: string; serviceName: string }

// The services a push to `repo`/`branch` deploys, in every environment. GitHub treats owner/name without regard to
// letter case but a branch name exactly. An instance without a source has no repo to compare, so it never matches.
export async function findPushTargets(db: Db, i: { repo: string; branch: string }): Promise<PushTarget[]> {
  return db
    .select({ instanceId: serviceInstances.id, projectName: projects.name, serviceName: services.name })
    .from(serviceInstances)
    .innerJoin(services, eq(serviceInstances.serviceId, services.id))
    .innerJoin(projects, eq(services.projectId, projects.id))
    .where(
      sql`lower(${serviceInstances.source}->>'repo') = lower(${i.repo}) and ${serviceInstances.source}->>'branch' = ${i.branch}`,
    )
    .orderBy(asc(projects.name), asc(services.name))
}

// Plain statement, not part of a transaction: the sync is wanted as soon as the admin asks for it.
export async function requestGithubSync(db: Db): Promise<void> {
  await db.execute(sql`select pg_notify(${GITHUB_SYNC_CHANNEL}, '')`)
}

export type GithubStatus = {
  ok: boolean
  checkedAt: string
  appSlug?: string
  installations?: { account: string; repositories: number }[]
  error?: string
}

export type WebhookDelivery = { event: string; deliveryId: string | null; receivedAt: string; outcome: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function putSetting(db: Db, key: string, value: unknown): Promise<void> {
  const row = { key, value, updatedAt: sql`now()`, updatedBy: null }
  await db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row })
}

async function getSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key))
  return row?.value
}

export async function setGithubStatus(db: Db, s: GithubStatus): Promise<void> {
  await putSetting(db, GITHUB_KEYS.status, s)
}

const isInstallation = (value: unknown): value is { account: string; repositories: number } =>
  isRecord(value) && typeof value.account === 'string' && typeof value.repositories === 'number'

// A stored value without `ok` and `checkedAt` of the right type is not a status. Optional fields of the wrong type
// are left out, so a status written by another version still shows what can be read from it.
export async function getGithubStatus(db: Db): Promise<GithubStatus | null> {
  const stored = await getSetting(db, GITHUB_KEYS.status)
  if (!isRecord(stored) || typeof stored.ok !== 'boolean' || typeof stored.checkedAt !== 'string') return null
  const status: GithubStatus = { ok: stored.ok, checkedAt: stored.checkedAt }
  if (typeof stored.appSlug === 'string') status.appSlug = stored.appSlug
  if (Array.isArray(stored.installations) && stored.installations.every(isInstallation)) {
    status.installations = stored.installations.map(({ account, repositories }) => ({ account, repositories }))
  }
  if (typeof stored.error === 'string') status.error = stored.error
  return status
}

export async function recordWebhookDelivery(db: Db, d: WebhookDelivery): Promise<void> {
  await putSetting(db, GITHUB_KEYS.lastWebhook, d)
}

export async function getLastWebhookDelivery(db: Db): Promise<WebhookDelivery | null> {
  const stored = await getSetting(db, GITHUB_KEYS.lastWebhook)
  if (
    !isRecord(stored) ||
    typeof stored.event !== 'string' ||
    typeof stored.receivedAt !== 'string' ||
    typeof stored.outcome !== 'string' ||
    !(typeof stored.deliveryId === 'string' || stored.deliveryId === null)
  ) {
    return null
  }
  return { event: stored.event, deliveryId: stored.deliveryId, receivedAt: stored.receivedAt, outcome: stored.outcome }
}
