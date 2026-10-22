'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { ActionState } from '../action-state'
import { actionError } from '../errors'
import { formText } from '../form'
import { beginAction } from '../guards'
import { doAddMember, doCreateProject, doDeleteProject, doRemoveMember } from '../projects'

export type { ActionState, FieldErrors } from '../action-state'

const membersPath = (projectName: string) => `/projects/${projectName}/members`

export async function createProjectAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await beginAction()
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
  const { db, actor } = await beginAction()
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
  const { db, actor } = await beginAction()
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
  const { db, actor } = await beginAction()
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
