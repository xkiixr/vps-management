import {
  type Actor,
  addMember,
  createProject,
  type Db,
  deleteProject,
  findProjectFor,
  listMembers,
  type Project,
  removeMember,
  ValidationError,
} from '@vpsm/db'
import { validateName } from '@vpsm/core'
import type { ActionState } from './action-state'
import { auditBestEffort } from './audit'
import { NotFoundError } from './errors'

// The logic of the project and member actions, apart from Next (headers, session, redirects), so that it can be
// tested against a database. Each function does what one action does for `actor`: it checks that the actor may
// see the project, does the work, records the audit event and says what to show. A ValidationError becomes
// part of the answer; anything unexpected is thrown for the action to turn into the generic message.
//
// The functions of @vpsm/db that take a project id check nothing about who is asking, so every function here
// starts from findProjectFor(). A project the actor may not see is NotFoundError, exactly as if it did not exist.

export const CONFIRM_MESSAGE = 'type the project name to confirm'

export async function visibleProject(db: Db, actor: Actor, name: string): Promise<Project> {
  // The name of a bound action argument comes from the browser and is not guaranteed to be text.
  const project = typeof name === 'string' ? await findProjectFor(db, actor, name) : null
  if (!project) throw new NotFoundError()
  return project
}

// Runs a change that may refuse with a message meant for the user. null when it went through.
export async function refusal(change: () => Promise<unknown>): Promise<{ error: string } | null> {
  try {
    await change()
    return null
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message }
    throw error
  }
}

export type CreateProjectResult = { project: { id: string; name: string } } | { fieldErrors: { name: string } }

/** The actor creates a project and becomes its first member. */
export async function doCreateProject(db: Db, actor: Actor, input: { name?: string }): Promise<CreateProjectResult> {
  const name = input.name ?? ''
  if (name === '') return { fieldErrors: { name: 'name is required' } }
  const validation = validateName(name)
  if (!validation.ok) return { fieldErrors: { name: validation.reason } }

  let project: Project
  try {
    project = await createProject(db, name, actor.id)
  } catch (error) {
    // The name is the only input, so what the database refuses (a name already taken) is about that field.
    if (error instanceof ValidationError) return { fieldErrors: { name: error.message } }
    throw error
  }
  await auditBestEffort(db, { actorId: actor.id, action: 'project.create', targetType: 'project', targetId: project.id, metadata: { name } })
  return { project: { id: project.id, name: project.name } }
}

/** Deletes the project when its name is typed in `confirm`. */
export async function doDeleteProject(db: Db, actor: Actor, projectName: string, input: { confirm?: string }): Promise<ActionState> {
  const project = await visibleProject(db, actor, projectName)
  if ((input.confirm ?? '').trim() !== project.name) return { error: CONFIRM_MESSAGE }

  const failed = await refusal(() => deleteProject(db, project.id))
  if (failed) return failed
  await auditBestEffort(db, { actorId: actor.id, action: 'project.delete', targetType: 'project', targetId: project.id, metadata: { name: project.name } })
  return {}
}

/** Makes the user with that email a member. Adding a member already there is not an error, and not an event. */
export async function doAddMember(db: Db, actor: Actor, projectName: string, input: { email?: string }): Promise<ActionState> {
  const project = await visibleProject(db, actor, projectName)
  // Emails are stored trimmed and lowercase.
  const email = (input.email ?? '').trim().toLowerCase()
  if (email === '') return { fieldErrors: { email: 'email is required' } }
  if ((await listMembers(db, project.id)).some((member) => member.user.email === email)) return {}

  const failed = await refusal(() => addMember(db, project.id, email))
  if (failed) return failed
  await auditBestEffort(db, { actorId: actor.id, action: 'member.add', targetType: 'project', targetId: project.id, metadata: { project: project.name, email } })
  return {}
}

export type RemoveMemberResult = ActionState & {
  /** The actor removed themselves and, not being an admin, no longer sees the project. */
  leftProject?: true
}

/** Removes a member. Someone who is not a member is not an error, and not an event. */
export async function doRemoveMember(db: Db, actor: Actor, projectName: string, userId: string): Promise<RemoveMemberResult> {
  const project = await visibleProject(db, actor, projectName)
  const member = (await listMembers(db, project.id)).find((m) => m.user.id === userId)
  if (!member) return {}

  const failed = await refusal(() => removeMember(db, project.id, member.user.id))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'member.remove',
    targetType: 'project',
    targetId: project.id,
    metadata: { project: project.name, email: member.user.email },
  })
  return member.user.id === actor.id && actor.role !== 'admin' ? { leftProject: true } : {}
}
