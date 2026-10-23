import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import {
  createAppService,
  createProject,
  findGithubRepository,
  findPushTargets,
  getGithubStatus,
  getLastWebhookDelivery,
  GITHUB_KEYS,
  GITHUB_SYNC_CHANNEL,
  listGithubRepositories,
  recordWebhookDelivery,
  replaceGithubRepositories,
  requestGithubSync,
  serviceInstances,
  setGithubStatus,
  settings,
  type GithubRepositoryInput,
} from '../src/index'
import { setupTestDb } from '../src/testing'
import { listenDuring } from './helpers'

const t = await setupTestDb()
const { db } = t
afterAll(() => t.close())

const addService = async (projectName: string, serviceName: string, source: { repo: string; branch: string }) =>
  (await createAppService(db, { projectName, serviceName, source, appsDomain: 'apps.example.com' })).instance

const repo = (id: number, fullName: string, extra: Partial<GithubRepositoryInput> = {}): GithubRepositoryInput => ({
  id,
  fullName,
  defaultBranch: 'main',
  private: false,
  installationId: 1,
  ...extra,
})

// Stores `value` as-is, including JSON null, which a plain insert would turn into an SQL NULL.
const storeRaw = (key: string, value: unknown) =>
  db.insert(settings).values({ key, value: sql`${JSON.stringify(value)}::jsonb` })

beforeEach(async () => {
  await t.reset()
  await createProject(db, 'p')
})

// --- push targets --------------------------------------------------------------------------------------

test('findPushTargets matches owner/name in any letter case and the branch exactly', async () => {
  const a = await addService('p', 'a', { repo: 'ITX-Insee/Web', branch: 'main' })
  await addService('p', 'b', { repo: 'itx-insee/web', branch: 'feature/login' })
  await addService('p', 'c', { repo: 'itx-insee/web', branch: 'Main' })

  expect(await findPushTargets(db, { repo: 'itx-insee/web', branch: 'main' })).toEqual([
    { instanceId: a.id, projectName: 'p', serviceName: 'a' },
  ])
  expect((await findPushTargets(db, { repo: 'ITX-INSEE/WEB', branch: 'feature/login' })).map((x) => x.serviceName)).toEqual([
    'b',
  ])
  expect((await findPushTargets(db, { repo: 'itx-insee/web', branch: 'Main' })).map((x) => x.serviceName)).toEqual(['c'])
  expect(await findPushTargets(db, { repo: 'itx-insee/web', branch: 'develop' })).toEqual([])
  expect(await findPushTargets(db, { repo: 'itx-insee/api', branch: 'main' })).toEqual([])
})

test('two services on the same repo and branch are both targets, ordered by project then service', async () => {
  await createProject(db, 'a-first')
  const a = await addService('p', 'a', { repo: 'ITX-Insee/Web', branch: 'main' })
  const d = await addService('a-first', 'd', { repo: 'itx-insee/web', branch: 'main' })
  const z = await addService('p', 'z', { repo: 'itx-insee/web', branch: 'main' })

  expect(await findPushTargets(db, { repo: 'itx-insee/web', branch: 'main' })).toEqual([
    { instanceId: d.id, projectName: 'a-first', serviceName: 'd' },
    { instanceId: a.id, projectName: 'p', serviceName: 'a' },
    { instanceId: z.id, projectName: 'p', serviceName: 'z' },
  ])
})

test('a service without a source is never a target', async () => {
  const a = await addService('p', 'a', { repo: 'itx-insee/web', branch: 'main' })
  const b = await addService('p', 'b', { repo: 'itx-insee/web', branch: 'main' })
  await db.update(serviceInstances).set({ source: null }).where(eq(serviceInstances.id, b.id))

  expect(await findPushTargets(db, { repo: 'itx-insee/web', branch: 'main' })).toEqual([
    { instanceId: a.id, projectName: 'p', serviceName: 'a' },
  ])
})

// --- repositories --------------------------------------------------------------------------------------

test('replaceGithubRepositories swaps the whole list', async () => {
  const x = repo(1, 'acme/x')
  const y = repo(2, 'acme/y', { private: true, installationId: 7, defaultBranch: 'trunk' })
  await replaceGithubRepositories(db, [x, y])
  expect((await listGithubRepositories(db)).map((r) => r.fullName)).toEqual(['acme/x', 'acme/y'])

  await replaceGithubRepositories(db, [y])
  const rows = await listGithubRepositories(db)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 2, fullName: 'acme/y', defaultBranch: 'trunk', private: true, installationId: 7 })
  expect(rows[0]!.syncedAt).toBeInstanceOf(Date)

  await replaceGithubRepositories(db, [])
  expect(await listGithubRepositories(db)).toEqual([])
})

test('replaceGithubRepositories keeps the old list when the new one cannot be stored', async () => {
  await replaceGithubRepositories(db, [repo(1, 'acme/x')])
  await expect(replaceGithubRepositories(db, [repo(2, 'acme/y'), repo(3, 'ACME/Y')])).rejects.toThrow()
  expect((await listGithubRepositories(db)).map((r) => r.fullName)).toEqual(['acme/x'])
})

test('listGithubRepositories is ordered by name without regard to letter case', async () => {
  await replaceGithubRepositories(db, [repo(1, 'acme/b'), repo(2, 'Acme/a'), repo(3, 'beta/Z'), repo(4, 'acme/C')])
  expect((await listGithubRepositories(db)).map((r) => r.fullName)).toEqual(['Acme/a', 'acme/b', 'acme/C', 'beta/Z'])
})

test('findGithubRepository ignores letter case', async () => {
  await replaceGithubRepositories(db, [repo(1, 'ITX-Insee/Web', { private: true }), repo(2, 'itx-insee/api')])
  expect(await findGithubRepository(db, 'itx-insee/web')).toMatchObject({ id: 1, fullName: 'ITX-Insee/Web', private: true })
  expect(await findGithubRepository(db, 'ITX-INSEE/WEB')).toMatchObject({ id: 1 })
  expect(await findGithubRepository(db, 'itx-insee/nope')).toBeNull()
})

// --- sync request --------------------------------------------------------------------------------------

test('requestGithubSync notifies GITHUB_SYNC_CHANNEL', async () => {
  expect(GITHUB_SYNC_CHANNEL).toBe('vpsm_github_sync')
  const payloads = await listenDuring(t.sql, GITHUB_SYNC_CHANNEL, () => requestGithubSync(db))
  expect(payloads).toEqual([''])
})

// --- status and last webhook ---------------------------------------------------------------------------

test('the settings keys have the agreed names', () => {
  expect(GITHUB_KEYS).toEqual({ status: 'githubStatus', lastWebhook: 'githubLastWebhook' })
})

test('nothing is known until the worker and the webhook have reported', async () => {
  expect(await getGithubStatus(db)).toBeNull()
  expect(await getLastWebhookDelivery(db)).toBeNull()
})

test('github status and last webhook round-trip', async () => {
  const status = {
    ok: true,
    checkedAt: '2026-10-23T10:00:00.000Z',
    appSlug: 'vpsm-deploy',
    installations: [{ account: 'itx-insee', repositories: 3 }],
  }
  await setGithubStatus(db, status)
  expect(await getGithubStatus(db)).toEqual(status)

  const failed = { ok: false, checkedAt: '2026-10-23T11:00:00.000Z', error: 'bad credentials' }
  await setGithubStatus(db, failed)
  expect(await getGithubStatus(db)).toEqual(failed)

  const delivery = { event: 'push', deliveryId: 'abc-123', receivedAt: '2026-10-23T10:05:00.000Z', outcome: 'queued 2' }
  await recordWebhookDelivery(db, delivery)
  expect(await getLastWebhookDelivery(db)).toEqual(delivery)

  const unnamed = { event: 'ping', deliveryId: null, receivedAt: '2026-10-23T10:06:00.000Z', outcome: 'pong' }
  await recordWebhookDelivery(db, unnamed)
  expect(await getLastWebhookDelivery(db)).toEqual(unnamed)
})

test('both values are stored in settings without a user', async () => {
  await setGithubStatus(db, { ok: true, checkedAt: '2026-10-23T10:00:00.000Z' })
  await recordWebhookDelivery(db, { event: 'push', deliveryId: null, receivedAt: '2026-10-23T10:05:00.000Z', outcome: 'ok' })
  const rows = await db.select().from(settings)
  expect(rows.map((r) => r.key).sort()).toEqual(['githubLastWebhook', 'githubStatus'])
  for (const row of rows) expect(row.updatedBy).toBeNull()
})

test.each<{ bad: unknown }>(
  ['ok', 42, null, [], {}, { ok: 'yes', checkedAt: '2026-10-23T10:00:00.000Z' }, { ok: true }, { ok: true, checkedAt: 1761213600000 }].map(
    (bad) => ({ bad }),
  ),
)('a stored github status of $bad reads as null', async ({ bad }) => {
  await storeRaw(GITHUB_KEYS.status, bad)
  expect(await getGithubStatus(db)).toBeNull()
})

test('a stored github status loses optional fields of the wrong type, not the whole value', async () => {
  await storeRaw(GITHUB_KEYS.status, {
    ok: false,
    checkedAt: '2026-10-23T10:00:00.000Z',
    appSlug: 7,
    installations: [{ account: 'itx-insee', repositories: 'many' }],
    error: 'boom',
  })
  expect(await getGithubStatus(db)).toEqual({ ok: false, checkedAt: '2026-10-23T10:00:00.000Z', error: 'boom' })
})

test.each<{ bad: unknown }>(
  [
    'push',
    7,
    null,
    [],
    {},
    { event: 'push', deliveryId: 'x', receivedAt: '2026-10-23T10:05:00.000Z' },
    { event: 'push', deliveryId: 'x', outcome: 'ok' },
    { deliveryId: 'x', receivedAt: '2026-10-23T10:05:00.000Z', outcome: 'ok' },
    { event: 'push', deliveryId: 5, receivedAt: '2026-10-23T10:05:00.000Z', outcome: 'ok' },
    { event: 'push', receivedAt: '2026-10-23T10:05:00.000Z', outcome: 'ok' },
  ].map((bad) => ({ bad })),
)('a stored last webhook of $bad reads as null', async ({ bad }) => {
  await storeRaw(GITHUB_KEYS.lastWebhook, bad)
  expect(await getLastWebhookDelivery(db)).toBeNull()
})
