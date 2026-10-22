import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_BUILD_CONFIG, type DeploymentStatus } from '@vpsm/core'
import {
  appendDeploymentLogs,
  claimNextDeployment,
  closeAbandonedLogs,
  createAppService,
  createProject,
  DEPLOYMENT_LOG_CHANNEL,
  DEPLOYMENTS_CHANNEL,
  deploymentLogs,
  deployments,
  domains,
  enqueueDeployment,
  InvalidTransitionError,
  loadDeploymentContext,
  markDeploymentLive,
  markLogsClosed,
  setDeploymentStatus,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'
import { listenDuring } from './helpers'

const t = await setupTestDb()
const { db } = t

let serviceInstanceId: string
let si1: string
let si2: string

beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  const web = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  const api = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'api',
    source: { repo: 'acme/api', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  serviceInstanceId = web.instance.id
  si1 = web.instance.id
  si2 = api.instance.id
})
afterAll(() => t.close())

async function get(id: string) {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id))
  return row!
}

// Queued -> DEPLOYING -> SUCCESS, i.e. a deployment that is live.
async function liveDeployment(instanceId: string) {
  const d = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'DEPLOYING')
  return setDeploymentStatus(db, d.id, 'SUCCESS', { containerName: `vpsm-web-${d.id.slice(0, 8)}` })
}

test('enqueue creates a QUEUED deployment with its metadata', async () => {
  const d = await enqueueDeployment(db, {
    serviceInstanceId,
    trigger: 'push',
    commitSha: 'abc123',
    commitMessage: 'fix: things',
  })
  expect(d).toMatchObject({
    serviceInstanceId,
    status: 'QUEUED',
    trigger: 'push',
    commitSha: 'abc123',
    commitMessage: 'fix: things',
    claimedAt: null,
    finishedAt: null,
  })
})

test('enqueue notifies the queue channel with the deployment id', async () => {
  let id = ''
  const payloads = await listenDuring(t.sql, DEPLOYMENTS_CHANNEL, async () => {
    id = (await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })).id
  })
  expect(payloads).toEqual([id])
})

test('enqueue skips older queued deployments of the same service', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  const b = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await get(a.id)).status).toBe('SKIPPED')
  expect((await get(a.id)).finishedAt).not.toBeNull()
  expect((await get(b.id)).status).toBe('QUEUED')
})

test('enqueue does not skip deployments of other services', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId: si1, trigger: 'push' })
  await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'push' })
  expect((await get(a.id)).status).toBe('QUEUED')
})

test('enqueue never skips a deployment that is already claimed', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await claimNextDeployment(db)
  await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await get(a.id)).status).toBe('QUEUED')
})

test.each(['push', 'manual', 'config', 'rollback'] as const)(
  'a restart is refused, not queued, while a %s deployment of the service is waiting',
  async (trigger) => {
    const waiting = await enqueueDeployment(db, { serviceInstanceId, trigger })

    await expect(enqueueDeployment(db, { serviceInstanceId, trigger: 'restart' })).rejects.toThrow(
      new ValidationError('a deployment is already queued for this service'),
    )

    expect((await get(waiting.id)).status).toBe('QUEUED')
    expect(await db.select().from(deployments).where(eq(deployments.serviceInstanceId, serviceInstanceId))).toHaveLength(1)
  },
)

test('a restart is queued when nothing waits, and when the queued deployment is already claimed', async () => {
  const first = await enqueueDeployment(db, { serviceInstanceId, trigger: 'restart' })
  expect(first.status).toBe('QUEUED')
  await claimNextDeployment(db)

  // Claimed: it is being worked on, not waiting, so it neither blocks nor is skipped.
  const second = await enqueueDeployment(db, { serviceInstanceId, trigger: 'restart' })

  expect(second.status).toBe('QUEUED')
  expect((await get(first.id)).status).toBe('QUEUED')
})

test('a waiting deployment of another service does not refuse a restart', async () => {
  const other = await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'push' })

  const restart = await enqueueDeployment(db, { serviceInstanceId: si1, trigger: 'restart' })

  expect(restart.status).toBe('QUEUED')
  expect((await get(other.id)).status).toBe('QUEUED')
})

test('a restart that is waiting is still skipped by a later deployment of another kind', async () => {
  const restart = await enqueueDeployment(db, { serviceInstanceId, trigger: 'restart' })
  const push = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await get(restart.id)).status).toBe('SKIPPED')
  expect((await get(push.id)).status).toBe('QUEUED')
})

test('a restart racing a push leaves exactly one QUEUED deployment', async () => {
  const results = await Promise.allSettled([
    enqueueDeployment(db, { serviceInstanceId, trigger: 'push' }),
    enqueueDeployment(db, { serviceInstanceId, trigger: 'restart' }),
  ])
  const rows = await db.select().from(deployments).where(eq(deployments.serviceInstanceId, serviceInstanceId))
  expect(rows.filter((d) => d.status === 'QUEUED')).toHaveLength(1)
  // Whichever came second either cancelled a restart or was refused; a push is never cancelled by a restart.
  const push = rows.find((d) => d.trigger === 'push')
  expect(push?.status).toBe('QUEUED')
  expect(results.filter((r) => r.status === 'rejected').length + rows.filter((d) => d.status === 'SKIPPED').length).toBe(1)
})

test('concurrent enqueues of one service leave exactly one QUEUED deployment', async () => {
  const created = await Promise.all(
    Array.from({ length: 6 }, () => enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })),
  )
  const statuses = await Promise.all(created.map(async (d) => (await get(d.id)).status))
  expect(statuses.filter((s) => s === 'QUEUED')).toHaveLength(1)
  expect(statuses.filter((s) => s === 'SKIPPED')).toHaveLength(5)
})

test('enqueue rejects an unknown service instance', async () => {
  await expect(
    enqueueDeployment(db, { serviceInstanceId: '00000000-0000-0000-0000-000000000000', trigger: 'manual' }),
  ).rejects.toThrow('service instance 00000000-0000-0000-0000-000000000000 not found')
})

test('claim is FIFO and returns null when empty', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId: si1, trigger: 'manual' })
  const b = await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'manual' })
  expect((await claimNextDeployment(db))!.id).toBe(a.id)
  expect((await claimNextDeployment(db))!.id).toBe(b.id)
  expect(await claimNextDeployment(db)).toBeNull()
})

test('claim stamps claimed_at and started_at but keeps the status QUEUED', async () => {
  await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const claimed = await claimNextDeployment(db)
  expect(claimed!.status).toBe('QUEUED')
  expect(claimed!.claimedAt).not.toBeNull()
  expect(claimed!.startedAt).toEqual(claimed!.claimedAt)
})

test('claim ignores deployments that are not QUEUED', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'SKIPPED')
  expect(await claimNextDeployment(db)).toBeNull()
})

test('concurrent claims never hand the same deployment to two workers', async () => {
  const queued = await Promise.all([
    enqueueDeployment(db, { serviceInstanceId: si1, trigger: 'manual' }),
    enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'manual' }),
  ])
  const claims = await Promise.all(Array.from({ length: 5 }, () => claimNextDeployment(db)))
  const claimedIds = claims.filter((c) => c !== null).map((c) => c.id)
  expect(claimedIds.sort()).toEqual(queued.map((d) => d.id).sort())
})

test('setDeploymentStatus rejects illegal transitions', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await expect(setDeploymentStatus(db, d.id, 'SUCCESS')).rejects.toBeInstanceOf(InvalidTransitionError)
  expect((await get(d.id)).status).toBe('QUEUED')
})

test('setDeploymentStatus throws for a missing deployment', async () => {
  await expect(setDeploymentStatus(db, '00000000-0000-0000-0000-000000000000', 'BUILDING')).rejects.toThrow(
    'deployment 00000000-0000-0000-0000-000000000000 not found',
  )
})

test('setDeploymentStatus applies the patch, including QUEUED -> DEPLOYING rollback data', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'rollback' })
  const snapshot = { build: DEFAULT_BUILD_CONFIG, env: { A: '1' } }
  const updated = await setDeploymentStatus(db, d.id, 'DEPLOYING', {
    imageTag: 'vpsm/x:y',
    configSnapshot: snapshot,
    commitSha: 'def456',
    commitMessage: 'old commit',
  })
  expect(updated).toMatchObject({
    status: 'DEPLOYING',
    imageTag: 'vpsm/x:y',
    configSnapshot: snapshot,
    commitSha: 'def456',
    commitMessage: 'old commit',
    finishedAt: null,
  })
})

test('setDeploymentStatus keeps existing columns the patch does not mention', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push', commitSha: 'abc123' })
  const updated = await setDeploymentStatus(db, d.id, 'BUILDING', { imageTag: 'vpsm/x:y' })
  expect(updated).toMatchObject({ status: 'BUILDING', commitSha: 'abc123', imageTag: 'vpsm/x:y' })
})

test.each<[DeploymentStatus, boolean]>([
  ['FAILED', true],
  ['SKIPPED', true],
  ['BUILDING', false],
])('setDeploymentStatus to %s from QUEUED: finished_at set = %s', async (to, finished) => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const updated = await setDeploymentStatus(db, d.id, to, to === 'FAILED' ? { failureReason: 'boom' } : undefined)
  expect(updated.status).toBe(to)
  expect(updated.finishedAt !== null).toBe(finished)
  if (to === 'FAILED') expect(updated.failureReason).toBe('boom')
})

test('setDeploymentStatus SUCCESS sets finished_at and later CRASHED leaves it unchanged', async () => {
  const live = await liveDeployment(serviceInstanceId)
  expect(live.finishedAt).not.toBeNull()
  const crashed = await setDeploymentStatus(db, live.id, 'CRASHED')
  expect(crashed.finishedAt).toEqual(live.finishedAt)
})

test('concurrent transitions are serialised: only one of two competing transitions wins', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const results = await Promise.allSettled([
    setDeploymentStatus(db, d.id, 'BUILDING'),
    setDeploymentStatus(db, d.id, 'SKIPPED'),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  expect(rejected).toHaveLength(1)
  expect(rejected[0]!.reason).toBeInstanceOf(InvalidTransitionError)
})

test('markDeploymentLive promotes new and removes previous', async () => {
  const prev = await liveDeployment(serviceInstanceId)
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await setDeploymentStatus(db, next.id, 'DEPLOYING')
  await markDeploymentLive(db, { deploymentId: next.id, containerName: 'vpsm-web-next', previousId: prev.id })
  expect(await get(next.id)).toMatchObject({ status: 'SUCCESS', containerName: 'vpsm-web-next' })
  expect((await get(next.id)).finishedAt).not.toBeNull()
  expect((await get(prev.id)).status).toBe('REMOVED')
})

test('markDeploymentLive also removes a CRASHED previous deployment', async () => {
  const prev = await liveDeployment(serviceInstanceId)
  await setDeploymentStatus(db, prev.id, 'CRASHED')
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await setDeploymentStatus(db, next.id, 'DEPLOYING')
  await markDeploymentLive(db, { deploymentId: next.id, containerName: 'vpsm-web-next', previousId: prev.id })
  expect((await get(prev.id)).status).toBe('REMOVED')
})

test('markDeploymentLive without a previous deployment only promotes the new one', async () => {
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await setDeploymentStatus(db, next.id, 'DEPLOYING')
  await markDeploymentLive(db, { deploymentId: next.id, containerName: 'vpsm-web-next' })
  expect((await get(next.id)).status).toBe('SUCCESS')
})

test('markDeploymentLive is all-or-nothing when the previous deployment cannot be removed', async () => {
  const stale = await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'manual' })
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await setDeploymentStatus(db, next.id, 'DEPLOYING')
  await expect(
    markDeploymentLive(db, { deploymentId: next.id, containerName: 'vpsm-web-next', previousId: stale.id }),
  ).rejects.toBeInstanceOf(InvalidTransitionError)
  expect(await get(next.id)).toMatchObject({ status: 'DEPLOYING', containerName: null, finishedAt: null })
  expect((await get(stale.id)).status).toBe('QUEUED')
})

test('appendDeploymentLogs stores lines in order', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await appendDeploymentLogs(db, d.id, 'build', ['a', 'b'])
  await appendDeploymentLogs(db, d.id, 'deploy', ['c'])
  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, d.id))
    .orderBy(deploymentLogs.id)
  expect(rows.map((r) => [r.phase, r.line])).toEqual([
    ['build', 'a'],
    ['build', 'b'],
    ['deploy', 'c'],
  ])
})

test('appendDeploymentLogs notifies the log channel with the deployment id', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const payloads = await listenDuring(t.sql, DEPLOYMENT_LOG_CHANNEL, () => appendDeploymentLogs(db, d.id, 'build', ['a']))
  expect(payloads).toEqual([d.id])
})

test('appendDeploymentLogs with no lines is a no-op', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const payloads = await listenDuring(t.sql, DEPLOYMENT_LOG_CHANNEL, () => appendDeploymentLogs(db, d.id, 'build', []))
  expect(payloads).toEqual([])
  expect(await db.select().from(deploymentLogs)).toHaveLength(0)
})

test('appendDeploymentLogs handles batches larger than the postgres parameter limit', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const lines = Array.from({ length: 25_000 }, (_, n) => `line ${n}`)
  await appendDeploymentLogs(db, d.id, 'build', lines)
  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, d.id))
    .orderBy(deploymentLogs.id)
  expect(rows).toHaveLength(25_000)
  expect(rows[0]!.line).toBe('line 0')
  expect(rows[24_999]!.line).toBe('line 24999')
})

test('loadDeploymentContext returns previous live deployment', async () => {
  const prev = await liveDeployment(serviceInstanceId)
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  const ctx = await loadDeploymentContext(db, next.id)
  expect(ctx.deployment.id).toBe(next.id)
  expect(ctx.previous!.id).toBe(prev.id)
  expect(ctx.rollbackSource).toBeNull()
  expect(ctx.project.name).toBe('shop')
  expect(ctx.environment.name).toBe('production')
  expect(ctx.service.name).toBe('web')
  expect(ctx.instance.id).toBe(serviceInstanceId)
  expect(ctx.domains.map((d) => d.hostname)).toEqual(['web-shop.apps.example.com'])
})

test('loadDeploymentContext previous is null without a live deployment and never the deployment itself', async () => {
  const first = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await loadDeploymentContext(db, first.id)).previous).toBeNull()
  await setDeploymentStatus(db, first.id, 'DEPLOYING')
  await setDeploymentStatus(db, first.id, 'SUCCESS')
  expect((await loadDeploymentContext(db, first.id)).previous).toBeNull()
})

test('loadDeploymentContext previous ignores failed and other-service deployments', async () => {
  const failed = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await setDeploymentStatus(db, failed.id, 'FAILED')
  await liveDeployment(si2)
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await loadDeploymentContext(db, next.id)).previous).toBeNull()
})

test('loadDeploymentContext previous is the most recent live deployment, not a removed one', async () => {
  const older = await liveDeployment(serviceInstanceId)
  await setDeploymentStatus(db, older.id, 'REMOVED')
  const newer = await liveDeployment(serviceInstanceId)
  const next = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await loadDeploymentContext(db, next.id)).previous!.id).toBe(newer.id)
})

test('loadDeploymentContext returns the rollback source', async () => {
  const source = await liveDeployment(serviceInstanceId)
  const rollback = await enqueueDeployment(db, { serviceInstanceId, trigger: 'rollback', rollbackOfId: source.id })
  const ctx = await loadDeploymentContext(db, rollback.id)
  expect(ctx.rollbackSource!.id).toBe(source.id)
  expect(ctx.previous!.id).toBe(source.id)
})

test('loadDeploymentContext lists every domain of the instance', async () => {
  await db.insert(domains).values({ serviceInstanceId, hostname: 'shop.example.org', kind: 'custom' })
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const ctx = await loadDeploymentContext(db, d.id)
  expect(ctx.domains.map((x) => x.hostname).sort()).toEqual(['shop.example.org', 'web-shop.apps.example.com'])
})

test('loadDeploymentContext throws for a missing deployment', async () => {
  await expect(loadDeploymentContext(db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
    'deployment 00000000-0000-0000-0000-000000000000 not found',
  )
})

test('a new deployment has not closed its log', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  expect(d.logsClosedAt).toBeNull()
  expect((await get(d.id)).logsClosedAt).toBeNull()
})

test('a status that is final does not close the log: only markLogsClosed does', async () => {
  const live = await liveDeployment(serviceInstanceId)
  expect(live.status).toBe('SUCCESS')
  expect((await get(live.id)).logsClosedAt).toBeNull()
  const failed = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'x' })
  expect((await get(failed.id)).logsClosedAt).toBeNull()
})

test('markLogsClosed stamps that deployment once, and only that one', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  const b = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await markLogsClosed(db, b.id)
  const first = (await get(b.id)).logsClosedAt
  expect(first).toBeInstanceOf(Date)
  expect(Math.abs(first!.getTime() - Date.now())).toBeLessThan(10_000)
  expect((await get(a.id)).logsClosedAt).toBeNull()

  await markLogsClosed(db, b.id)
  expect((await get(b.id)).logsClosedAt).toEqual(first)
})

test('markLogsClosed does nothing for an id that is no deployment', async () => {
  await markLogsClosed(db, '00000000-0000-0000-0000-000000000000')
  await markLogsClosed(db, 'not-a-uuid')
})

test('closeAbandonedLogs closes the log of every deployment that is over and counts them, and leaves the others', async () => {
  const make = async (status: DeploymentStatus) => {
    const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
    await db.update(deployments).set({ status }).where(eq(deployments.id, d.id))
    return d.id
  }
  const over = [await make('SUCCESS'), await make('FAILED'), await make('CRASHED'), await make('REMOVED')]
  const open = [await make('QUEUED'), await make('BUILDING'), await make('DEPLOYING')]
  const closedEarlier = await make('FAILED')
  await markLogsClosed(db, closedEarlier)
  const stamp = (await get(closedEarlier)).logsClosedAt

  expect(await closeAbandonedLogs(db)).toBe(over.length)
  for (const id of over) expect((await get(id)).logsClosedAt).toBeInstanceOf(Date)
  for (const id of open) expect((await get(id)).logsClosedAt).toBeNull()
  expect((await get(closedEarlier)).logsClosedAt).toEqual(stamp)
  expect(await closeAbandonedLogs(db)).toBe(0)
})
