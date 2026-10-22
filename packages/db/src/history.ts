import { and, asc, desc, eq, getTableColumns, gt } from 'drizzle-orm'
import type { Db } from './client'
import { ValidationError } from './errors'
import { isUuid } from './input'
import { type Deployment, deploymentLogs, deployments, serviceInstances, services, users } from './schema'

// Newest first. Only the creator's email is joined in, never the rest of the user row.
export async function listDeployments(
  db: Db,
  instanceId: string,
  limit = 50,
): Promise<(Deployment & { createdByEmail: string | null })[]> {
  if (!isUuid(instanceId)) return []
  return db
    .select({ ...getTableColumns(deployments), createdByEmail: users.email })
    .from(deployments)
    .leftJoin(users, eq(deployments.createdById, users.id))
    .where(eq(deployments.serviceInstanceId, instanceId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(limit)
}

// Null for a deployment of another project too, so an id taken from a URL cannot reach outside the project.
export async function findDeploymentInProject(
  db: Db,
  projectId: string,
  deploymentId: string,
): Promise<Deployment | null> {
  if (!isUuid(projectId) || !isUuid(deploymentId)) return null
  const [row] = await db
    .select({ deployment: deployments })
    .from(deployments)
    .innerJoin(serviceInstances, eq(deployments.serviceInstanceId, serviceInstances.id))
    .innerJoin(services, eq(serviceInstances.serviceId, services.id))
    .where(and(eq(deployments.id, deploymentId), eq(services.projectId, projectId)))
  return row?.deployment ?? null
}

// Lines after `afterId` in the order they were written; pass the last id seen to get the next page.
export async function readLogs(
  db: Db,
  deploymentId: string,
  afterId = 0,
  limit = 2000,
): Promise<{ id: number; phase: 'build' | 'deploy'; line: string }[]> {
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ValidationError('invalid log position')
  }
  if (!isUuid(deploymentId)) return []
  return db
    .select({ id: deploymentLogs.id, phase: deploymentLogs.phase, line: deploymentLogs.line })
    .from(deploymentLogs)
    .where(and(eq(deploymentLogs.deploymentId, deploymentId), gt(deploymentLogs.id, afterId)))
    .orderBy(asc(deploymentLogs.id))
    .limit(limit)
}
