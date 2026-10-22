import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import {
  type FieldErrors,
  publicUrl,
  type ServiceInput,
  type SourceConfig,
  validateName,
  validateServiceInput,
} from '@vpsm/core'
import type { Db } from './client'
import { ValidationError } from './errors'
import { CONTROL_CHARACTERS, isUuid } from './input'
import { PRODUCTION_ENVIRONMENT } from './projects'
import {
  type Deployment,
  deployments,
  domains,
  environments,
  projects,
  type Service,
  type ServiceInstance,
  serviceInstances,
  services,
} from './schema'

// The worker removes containers, networks and images of deleted services when it hears this.
export const CLEANUP_CHANNEL = 'vpsm_cleanup'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Field = keyof ServiceInput

export type ServiceRow = {
  service: Service
  instance: ServiceInstance
  // From the first generated domain (by hostname); null when the instance has none.
  url: string | null
  latest: Pick<Deployment, 'id' | 'status' | 'createdAt'> | null
  // The newest SUCCESS deployment, i.e. the one serving traffic.
  live: Pick<Deployment, 'id' | 'imageTag' | 'configSnapshot'> | null
}

// --- reading -------------------------------------------------------------------------------------------

async function loadServiceRows(db: Db, where: SQL | undefined, httpsPort: number): Promise<ServiceRow[]> {
  const rows = await db
    .select({ service: services, instance: serviceInstances })
    .from(services)
    .innerJoin(serviceInstances, eq(serviceInstances.serviceId, services.id))
    .innerJoin(environments, eq(serviceInstances.environmentId, environments.id))
    .where(and(where, eq(environments.name, PRODUCTION_ENVIRONMENT)))
    .orderBy(asc(services.name))
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.instance.id)
  const newestFirst = [asc(deployments.serviceInstanceId), desc(deployments.createdAt), desc(deployments.id)]
  const [hostnames, latest, live] = await Promise.all([
    db
      .selectDistinctOn([domains.serviceInstanceId], { instanceId: domains.serviceInstanceId, hostname: domains.hostname })
      .from(domains)
      .where(and(inArray(domains.serviceInstanceId, ids), eq(domains.kind, 'generated')))
      .orderBy(asc(domains.serviceInstanceId), asc(domains.hostname)),
    db
      .selectDistinctOn([deployments.serviceInstanceId], {
        instanceId: deployments.serviceInstanceId,
        id: deployments.id,
        status: deployments.status,
        createdAt: deployments.createdAt,
      })
      .from(deployments)
      .where(inArray(deployments.serviceInstanceId, ids))
      .orderBy(...newestFirst),
    db
      .selectDistinctOn([deployments.serviceInstanceId], {
        instanceId: deployments.serviceInstanceId,
        id: deployments.id,
        imageTag: deployments.imageTag,
        configSnapshot: deployments.configSnapshot,
      })
      .from(deployments)
      .where(and(inArray(deployments.serviceInstanceId, ids), eq(deployments.status, 'SUCCESS')))
      .orderBy(...newestFirst),
  ])

  const byInstance = <T extends { instanceId: string }>(list: T[]) =>
    new Map(list.map(({ instanceId, ...rest }) => [instanceId, rest]))
  const hostnameOf = byInstance(hostnames)
  const latestOf = byInstance(latest)
  const liveOf = byInstance(live)
  return rows.map(({ service, instance }) => {
    const domain = hostnameOf.get(instance.id)
    return {
      service,
      instance,
      url: domain ? publicUrl(domain.hostname, httpsPort) : null,
      latest: latestOf.get(instance.id) ?? null,
      live: liveOf.get(instance.id) ?? null,
    }
  })
}

export function listServices(db: Db, projectId: string, opts: { httpsPort: number }): Promise<ServiceRow[]> {
  return loadServiceRows(db, eq(services.projectId, projectId), opts.httpsPort)
}

export async function findService(
  db: Db,
  projectId: string,
  serviceName: string,
  opts: { httpsPort: number },
): Promise<ServiceRow | null> {
  if (!validateName(serviceName).ok) return null
  const where = and(eq(services.projectId, projectId), eq(services.name, serviceName))
  return (await loadServiceRows(db, where, opts.httpsPort))[0] ?? null
}

// Structural equality of JSON values: key order does not matter, and a key whose value is undefined counts as
// absent (jsonb never stores one).
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((key) => sameJson(x[key], y[key]))
}

// True when the saved settings differ from those the live deployment runs with. Without a live deployment, or
// with one that has no config snapshot, there is nothing to compare against, so there is nothing to warn about.
export function configChangedSinceLiveDeploy(row: ServiceRow): boolean {
  const snapshot = row.live?.configSnapshot
  if (typeof snapshot !== 'object' || snapshot === null) return false
  const live = snapshot as { source?: unknown; build?: unknown; deploy?: unknown }
  const { instance } = row
  return !(
    sameJson(instance.source ?? null, live.source ?? null) &&
    sameJson(instance.build, live.build) &&
    sameJson(instance.deploy, live.deploy)
  )
}

// --- updating ------------------------------------------------------------------------------------------

const STRING_FIELDS = ['repo', 'branch', 'rootDirectory', 'healthcheckPath', 'startCommand'] as const
const OPTIONAL_FIELDS: ReadonlySet<Field> = new Set(['rootDirectory', 'healthcheckPath', 'startCommand'])
const SOURCE_FIELDS: readonly Field[] = ['repo', 'branch', 'rootDirectory']
const DEPLOY_FIELDS: readonly Field[] = ['healthcheckPath', 'port', 'memoryLimitMB', 'startCommand']

function applyFields<T extends object>(current: T, fields: readonly Field[], values: ServiceInput, removed: Set<Field>): T {
  const next = { ...current } as Record<string, unknown>
  for (const field of fields) {
    if (removed.has(field)) delete next[field]
    else if (values[field] !== undefined) next[field] = values[field]
  }
  return next as T
}

/**
 * Saves the user-editable settings of a service instance: repo, branch and rootDirectory into `source`, the
 * rest into `deploy`. Strings are trimmed, and '' for an optional field (rootDirectory, healthcheckPath,
 * startCommand) removes it. Nothing is written unless every given field is valid.
 */
export async function updateServiceConfig(
  db: Db,
  instanceId: string,
  patch: ServiceInput,
  limits: { maxServiceMemoryMb: number },
): Promise<{ ok: true } | { ok: false; errors: FieldErrors }> {
  if (!isUuid(instanceId)) throw new ValidationError('service not found')

  const values: ServiceInput = { port: patch.port, memoryLimitMB: patch.memoryLimitMB }
  const removed = new Set<Field>()
  const characterErrors: FieldErrors = {}
  for (const field of STRING_FIELDS) {
    const value = patch[field]?.trim()
    if (value === undefined) continue
    if (CONTROL_CHARACTERS.test(value)) characterErrors[field] = 'contains invalid characters'
    else if (value === '' && OPTIONAL_FIELDS.has(field)) removed.add(field)
    else values[field] = value
  }
  const touchesSource = SOURCE_FIELDS.some((field) => values[field] !== undefined || removed.has(field))

  return db.transaction(async (tx) => {
    const [instance] = await tx
      .select({ source: serviceInstances.source, deploy: serviceInstances.deploy })
      .from(serviceInstances)
      .where(eq(serviceInstances.id, instanceId))
      .for('no key update')
    if (!instance) throw new ValidationError('service not found')

    // A service without a source only gets one together with both a repo and a branch.
    const input = instance.source === null && touchesSource ? { repo: '', branch: '', ...values } : values
    const errors: FieldErrors = { ...validateServiceInput(input, limits), ...characterErrors }
    if (Object.keys(errors).length > 0) return { ok: false, errors }

    const source = touchesSource
      ? applyFields(instance.source ?? ({} as SourceConfig), SOURCE_FIELDS, values, removed)
      : instance.source
    const deploy = applyFields(instance.deploy, DEPLOY_FIELDS, values, removed)
    await tx.update(serviceInstances).set({ source, deploy }).where(eq(serviceInstances.id, instanceId))
    return { ok: true }
  })
}

// --- deleting ------------------------------------------------------------------------------------------

const RUNNING_MESSAGE = 'wait for the running deployment to finish'

// Lock order, shared by both deletes: project row, then service_instances rows, then deployments rows, each in
// id order. enqueueDeployment locks only the instance row (FOR NO KEY UPDATE, which FOR UPDATE excludes), and a
// worker claim or status change locks only deployment rows and never waits for an instance, so no cycle can form.
async function lockInstances(tx: Tx, where: SQL): Promise<string[]> {
  const rows = await tx
    .select({ id: serviceInstances.id })
    .from(serviceInstances)
    .where(where)
    .orderBy(asc(serviceInstances.id))
    .for('update')
  return rows.map((row) => row.id)
}

// Expects the instances locked already. Locking their unfinished deployments as well means a claim in progress
// (which holds its row) is waited for and then seen as claimed, and a claim that comes later skips these rows.
async function assertNothingRunning(tx: Tx, instanceIds: string[]): Promise<void> {
  if (instanceIds.length === 0) return
  const unfinished = await tx
    .select({ status: deployments.status, claimedAt: deployments.claimedAt })
    .from(deployments)
    .where(
      and(
        inArray(deployments.serviceInstanceId, instanceIds),
        inArray(deployments.status, ['QUEUED', 'BUILDING', 'DEPLOYING']),
      ),
    )
    .orderBy(asc(deployments.id))
    .for('update')
  if (unfinished.some((d) => d.status !== 'QUEUED' || d.claimedAt !== null)) throw new ValidationError(RUNNING_MESSAGE)
}

// pg_notify is delivered on commit, so the worker never cleans up after a delete that was rolled back.
async function notifyCleanup(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_notify(${CLEANUP_CHANNEL}, '')`)
}

// Deletes the service of the instance with everything under it (cascade). Its containers are left for the worker.
export async function deleteService(db: Db, instanceId: string): Promise<void> {
  if (!isUuid(instanceId)) throw new ValidationError('service not found')
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ serviceId: serviceInstances.serviceId })
      .from(serviceInstances)
      .where(eq(serviceInstances.id, instanceId))
    // Every instance of the service goes with it, so every one of them is checked.
    const instanceIds = target ? await lockInstances(tx, eq(serviceInstances.serviceId, target.serviceId)) : []
    if (!target || instanceIds.length === 0) throw new ValidationError('service not found')
    await assertNothingRunning(tx, instanceIds)
    await tx.delete(services).where(eq(services.id, target.serviceId))
    await notifyCleanup(tx)
  })
}

export async function deleteProject(db: Db, projectId: string): Promise<void> {
  if (!isUuid(projectId)) throw new ValidationError('project not found')
  await db.transaction(async (tx) => {
    // Locked first: adding a service to the project (its foreign key check) has to wait until this is done.
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')
    if (!project) throw new ValidationError('project not found')
    const projectServices = tx.select({ id: services.id }).from(services).where(eq(services.projectId, projectId))
    await assertNothingRunning(tx, await lockInstances(tx, inArray(serviceInstances.serviceId, projectServices)))
    await tx.delete(projects).where(eq(projects.id, projectId))
    await notifyCleanup(tx)
  })
}
