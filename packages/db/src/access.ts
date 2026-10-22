import { and, asc, count, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm'
import { validateName } from '@vpsm/core'
import type { Db } from './client'
import { ValidationError } from './errors'
import { CONTROL_CHARACTERS, isUuid, normalizeEmail } from './input'
import {
  type Deployment,
  deployments,
  type Project,
  projectMembers,
  projects,
  type Service,
  serviceInstances,
  services,
  type User,
  users,
} from './schema'

// Who is asking. Admins see every project; anyone else only the projects they are a member of.
export type Actor = { id: string; role: 'admin' | 'member' }

// The condition that limits a query on `projects` to what the actor may see, or false when the actor can see
// nothing (an id that is not a uuid cannot be a member, and comparing it with a uuid column would error).
function visibleTo(db: Db, actor: Actor): SQL | undefined | false {
  if (actor.role === 'admin') return undefined
  if (!isUuid(actor.id)) return false
  const memberships = db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, actor.id))
  return inArray(projects.id, memberships)
}

export async function listProjectsFor(db: Db, actor: Actor): Promise<{ project: Project; serviceCount: number }[]> {
  const visible = visibleTo(db, actor)
  if (visible === false) return []
  return db
    .select({ project: projects, serviceCount: count(services.id) })
    .from(projects)
    .leftJoin(services, eq(services.projectId, projects.id))
    .where(visible)
    .groupBy(projects.id)
    .orderBy(asc(projects.name))
}

// A project that does not exist and one the actor may not see both give null, so callers cannot tell them apart.
export async function findProjectFor(db: Db, actor: Actor, projectName: string): Promise<Project | null> {
  const visible = visibleTo(db, actor)
  if (visible === false || !validateName(projectName).ok) return null
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.name, projectName), visible))
  return project ?? null
}

/**
 * A deployment with its project and service, found from its id alone (a URL that carries nothing else), when the
 * actor may see its project. A deployment that does not exist, and one in a project the actor may not see, both
 * give null. Only the creator's email is joined in (null for a push, or when the creator was deleted).
 */
export async function findDeploymentFor(
  db: Db,
  actor: Actor,
  deploymentId: string,
): Promise<{ deployment: Deployment & { createdByEmail: string | null }; project: Project; service: Service } | null> {
  const visible = visibleTo(db, actor)
  if (visible === false || !isUuid(deploymentId)) return null
  const [row] = await db
    .select({
      deployment: { ...getTableColumns(deployments), createdByEmail: users.email },
      project: projects,
      service: services,
    })
    .from(deployments)
    .innerJoin(serviceInstances, eq(deployments.serviceInstanceId, serviceInstances.id))
    .innerJoin(services, eq(serviceInstances.serviceId, services.id))
    .innerJoin(projects, eq(services.projectId, projects.id))
    .leftJoin(users, eq(deployments.createdById, users.id))
    .where(and(eq(deployments.id, deploymentId), visible))
  return row ?? null
}

export function listMembers(
  db: Db,
  projectId: string,
): Promise<{ user: Pick<User, 'id' | 'email' | 'name'>; addedAt: Date }[]> {
  return db
    .select({ user: { id: users.id, email: users.email, name: users.name }, addedAt: projectMembers.createdAt })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.email))
}

// Adding someone who is already a member is not an error.
export async function addMember(db: Db, projectId: string, email: string): Promise<void> {
  const normalized = normalizeEmail(email)
  const [user] = CONTROL_CHARACTERS.test(normalized)
    ? []
    : await db.select({ id: users.id }).from(users).where(eq(users.email, normalized))
  if (!user) throw new ValidationError('no user with that email')
  await db.insert(projectMembers).values({ projectId, userId: user.id }).onConflictDoNothing()
}

// Removing someone who is not a member is not an error. The project row is locked first, so two members
// removing each other at the same time run one after the other and the second sees that only one is left.
export async function removeMember(db: Db, projectId: string, userId: string): Promise<void> {
  if (!isUuid(userId)) return
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('no key update')
    if (!project) return
    const members = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
    if (!members.some((m) => m.userId === userId)) return
    if (members.length === 1) throw new ValidationError('a project needs at least one member')
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
  })
}
