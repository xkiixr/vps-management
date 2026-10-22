import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { canTransition, type DeploymentStatus, type DeploymentTrigger } from '@vpsm/core'
import type { Db } from './client'
import { ValidationError } from './errors'
import { isUuid } from './input'
import {
  type Deployment,
  deploymentLogs,
  deployments,
  type Domain,
  domains,
  type Environment,
  environments,
  type Project,
  projects,
  type Service,
  type ServiceInstance,
  serviceInstances,
  services,
} from './schema'

export const DEPLOYMENTS_CHANNEL = 'vpsm_deployments_queued'
export const DEPLOYMENT_LOG_CHANNEL = 'vpsm_deployment_log'

// Each row carries 3 bind parameters and postgres allows at most 65535 per statement.
const LOG_INSERT_BATCH_SIZE = 5000

const FINISHED_STATUSES: readonly DeploymentStatus[] = ['SUCCESS', 'FAILED', 'SKIPPED']

/**
 * A restart runs the image of the newest deployment in one of these again: the one serving traffic, or the one
 * whose container crashed. The worker picks it as `previous` (loadDeploymentContext) and the dashboard shows the
 * same one as `current` (ServiceRow), so Restart is offered exactly when the worker has something to restart.
 */
export const RESTARTABLE_STATUSES = ['SUCCESS', 'CRASHED'] as const satisfies readonly DeploymentStatus[]

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export class InvalidTransitionError extends Error {
  constructor(deploymentId: string, from: DeploymentStatus, to: DeploymentStatus) {
    super(`deployment ${deploymentId} cannot transition from ${from} to ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

export type DeploymentContext = {
  deployment: Deployment
  project: Project
  environment: Environment
  service: Service
  instance: ServiceInstance
  domains: Domain[]
  previous: Deployment | null
  rollbackSource: Deployment | null
}

export type DeploymentPatch = {
  failureReason?: string
  commitSha?: string
  commitMessage?: string
  imageTag?: string
  containerName?: string
  configSnapshot?: unknown
}

// pg_notify is delivered when the surrounding transaction commits, so callers send it inside theirs.
async function notify(tx: Tx, channel: string, payload: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${channel}, ${payload})`)
}

export async function enqueueDeployment(
  db: Db,
  i: {
    serviceInstanceId: string
    trigger: DeploymentTrigger
    commitSha?: string
    commitMessage?: string
    rollbackOfId?: string
    createdById?: string
  },
): Promise<Deployment> {
  return db.transaction(async (tx) => {
    // Serialises enqueues of the same service so concurrent pushes cannot both stay QUEUED.
    const [instance] = await tx
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(eq(serviceInstances.id, i.serviceInstanceId))
      .for('no key update')
    if (!instance) throw new Error(`service instance ${i.serviceInstanceId} not found`)

    const waiting = and(
      eq(deployments.serviceInstanceId, i.serviceInstanceId),
      eq(deployments.status, 'QUEUED'),
      isNull(deployments.claimedAt),
    )
    if (i.trigger === 'restart') {
      // A newer deployment replaces the ones waiting behind it, but a restart must never cancel one (a push
      // that was queued is the user's newer code). It is refused instead, and can be asked for again.
      const [queued] = await tx.select({ id: deployments.id }).from(deployments).where(waiting).limit(1)
      if (queued) throw new ValidationError('a deployment is already queued for this service')
    } else {
      await tx.update(deployments).set({ status: 'SKIPPED', finishedAt: sql`now()` }).where(waiting)
    }

    const [created] = await tx
      .insert(deployments)
      .values({
        serviceInstanceId: i.serviceInstanceId,
        trigger: i.trigger,
        commitSha: i.commitSha,
        commitMessage: i.commitMessage,
        rollbackOfId: i.rollbackOfId,
        createdById: i.createdById,
      })
      .returning()
    await notify(tx, DEPLOYMENTS_CHANNEL, created!.id)
    return created!
  })
}

export async function claimNextDeployment(db: Db): Promise<Deployment | null> {
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, 'QUEUED'), isNull(deployments.claimedAt)))
      .orderBy(asc(deployments.createdAt), asc(deployments.id))
      .limit(1)
      .for('update', { skipLocked: true })
    if (!next) return null

    const [claimed] = await tx
      .update(deployments)
      .set({ claimedAt: sql`now()`, startedAt: sql`now()` })
      .where(eq(deployments.id, next.id))
      .returning()
    return claimed!
  })
}

// Reads the row FOR UPDATE so two concurrent transitions cannot both pass the canTransition check.
async function transition(tx: Tx, id: string, to: DeploymentStatus, patch: DeploymentPatch = {}): Promise<Deployment> {
  const [current] = await tx
    .select({ status: deployments.status })
    .from(deployments)
    .where(eq(deployments.id, id))
    .for('update')
  if (!current) throw new Error(`deployment ${id} not found`)
  if (!canTransition(current.status, to)) throw new InvalidTransitionError(id, current.status, to)

  const [updated] = await tx
    .update(deployments)
    .set({
      status: to,
      failureReason: patch.failureReason,
      commitSha: patch.commitSha,
      commitMessage: patch.commitMessage,
      imageTag: patch.imageTag,
      containerName: patch.containerName,
      configSnapshot: patch.configSnapshot,
      finishedAt: FINISHED_STATUSES.includes(to) ? sql`now()` : undefined,
    })
    .where(eq(deployments.id, id))
    .returning()
  return updated!
}

export async function setDeploymentStatus(
  db: Db,
  id: string,
  to: DeploymentStatus,
  patch: DeploymentPatch = {},
): Promise<Deployment> {
  return db.transaction((tx) => transition(tx, id, to, patch))
}

export async function markDeploymentLive(
  db: Db,
  i: { deploymentId: string; containerName: string; previousId?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, i.deploymentId, 'SUCCESS', { containerName: i.containerName })
    if (i.previousId !== undefined) await transition(tx, i.previousId, 'REMOVED')
  })
}

export async function appendDeploymentLogs(
  db: Db,
  deploymentId: string,
  phase: 'build' | 'deploy',
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return
  await db.transaction(async (tx) => {
    for (let start = 0; start < lines.length; start += LOG_INSERT_BATCH_SIZE) {
      const batch = lines.slice(start, start + LOG_INSERT_BATCH_SIZE)
      await tx.insert(deploymentLogs).values(batch.map((line) => ({ deploymentId, phase, line })))
    }
    await notify(tx, DEPLOYMENT_LOG_CHANNEL, deploymentId)
  })
}

/**
 * Records that nothing more will be written to the deployment's log. The worker calls it once the log sink is
 * drained, after the final status: the status alone says nothing about the tail of the log (SUCCESS is set
 * before the last lines about going live and stopping the old container, FAILED before the failure line is
 * written), so a reader that wants to stop asking waits for this. Calling it again keeps the first time.
 */
export async function markLogsClosed(db: Db, deploymentId: string): Promise<void> {
  if (!isUuid(deploymentId)) return
  await db
    .update(deployments)
    .set({ logsClosedAt: sql`now()` })
    .where(and(eq(deployments.id, deploymentId), isNull(deployments.logsClosedAt)))
}

/**
 * For the start of the worker, when nothing is running: closes the log of every deployment that is over but whose
 * log was never closed, because the worker stopped between its final status and the end of its log (a live
 * deployment stays SUCCESS while the old container is drained). Returns how many were closed.
 */
export async function closeAbandonedLogs(db: Db): Promise<number> {
  const closed = await db
    .update(deployments)
    .set({ logsClosedAt: sql`now()` })
    .where(and(isNull(deployments.logsClosedAt), inArray(deployments.status, ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'])))
    .returning({ id: deployments.id })
  return closed.length
}

export async function loadDeploymentContext(db: Db, deploymentId: string): Promise<DeploymentContext> {
  const [row] = await db
    .select({
      deployment: deployments,
      instance: serviceInstances,
      service: services,
      environment: environments,
      project: projects,
    })
    .from(deployments)
    .innerJoin(serviceInstances, eq(deployments.serviceInstanceId, serviceInstances.id))
    .innerJoin(services, eq(serviceInstances.serviceId, services.id))
    .innerJoin(environments, eq(serviceInstances.environmentId, environments.id))
    .innerJoin(projects, eq(services.projectId, projects.id))
    .where(eq(deployments.id, deploymentId))
  if (!row) throw new Error(`deployment ${deploymentId} not found`)

  const { deployment, instance } = row
  const [instanceDomains, [previous], [rollbackSource]] = await Promise.all([
    db
      .select()
      .from(domains)
      .where(eq(domains.serviceInstanceId, instance.id))
      .orderBy(asc(domains.createdAt), asc(domains.hostname)),
    db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceInstanceId, instance.id),
          inArray(deployments.status, [...RESTARTABLE_STATUSES]),
          ne(deployments.id, deployment.id),
        ),
      )
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(1),
    deployment.rollbackOfId === null
      ? Promise.resolve([])
      : db.select().from(deployments).where(eq(deployments.id, deployment.rollbackOfId)),
  ])
  return { ...row, domains: instanceDomains, previous: previous ?? null, rollbackSource: rollbackSource ?? null }
}
