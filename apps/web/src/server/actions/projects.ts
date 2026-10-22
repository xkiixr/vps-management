'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Actor, Db } from '@vpsm/db'
import type { ActionState } from '../action-state'
import { webConfig } from '../config'
import { getDb } from '../db'
import { actionError } from '../errors'
import { formText } from '../form'
import { requireUser } from '../guards'
import { assertSameOrigin } from '../origin'
import { doAddMember, doCreateProject, doDeleteProject, doRemoveMember } from '../projects'

export type { ActionState, FieldErrors } from '../action-state'

// The start of every action: the request must come from the panel's own pages, then there must be a signed-in
// user (anyone else is sent to /login). Nothing else is read or done before both.
async function begin(): Promise<{ db: Db; actor: Actor }> {
  assertSameOrigin(await headers(), webConfig().panelOrigin)
  const user = await requireUser()
  return { db: getDb(), actor: { id: user.id, role: user.role } }
}

const membersPath = (projectName: string) => `/projects/${projectName}/members`

export async function createProjectAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await begin()
  let result: Awaited<ReturnType<typeof doCreateProject>>
  try {
    result = await doCreateProject(db, actor, { name: formText(formData, 'name') })
  } catch (error) {
    return actionError(error, 'creating project')
  }
  if (!('project' in result)) return result
  revalidatePath('/')
  redirect(`/projects/${result.project.name}`)
}

// The project's name is bound to the action by the page: deleteProjectAction.bind(null, name).
export async function deleteProjectAction(projectName: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await begin()
  let result: ActionState
  try {
    result = await doDeleteProject(db, actor, projectName, { confirm: formText(formData, 'confirm') })
  } catch (error) {
    return actionError(error, 'deleting project')
  }
  if (result.error || result.fieldErrors) return result
  revalidatePath('/')
  redirect('/')
}

export async function addMemberAction(projectName: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await begin()
  let result: ActionState
  try {
    result = await doAddMember(db, actor, projectName, { email: formText(formData, 'email') })
  } catch (error) {
    return actionError(error, 'adding member')
  }
  if (!result.error && !result.fieldErrors) revalidatePath(membersPath(projectName))
  return result
}

// Both ids are bound to the action by the page: removeMemberAction.bind(null, projectName, userId).
export async function removeMemberAction(
  projectName: string,
  userId: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await begin()
  let result: Awaited<ReturnType<typeof doRemoveMember>>
  try {
    result = await doRemoveMember(db, actor, projectName, userId)
  } catch (error) {
    return actionError(error, 'removing member')
  }
  if (result.error) return result
  if (result.leftProject) {
    // The project is no longer theirs to see; its members page would be a 404.
    revalidatePath('/')
    redirect('/')
  }
  revalidatePath(membersPath(projectName))
  return result
}
