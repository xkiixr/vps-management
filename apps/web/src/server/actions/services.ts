'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { ActionState } from '../action-state'
import { webConfig } from '../config'
import { actionError } from '../errors'
import { formText, formTexts } from '../form'
import { beginAction } from '../guards'
import {
  CREATE_FIELDS,
  doCreateService,
  doDeleteService,
  doSaveServiceSettings,
  SERVICE_FIELDS,
} from '../services'

export type { ActionState, FieldErrors } from '../action-state'

const projectPath = (projectName: string) => `/projects/${projectName}`
const servicePath = (projectName: string, serviceName: string) => `${projectPath(projectName)}/services/${serviceName}`

// The names bound to an action by its page (projectName, serviceName) come from the browser. The logic looks them
// up before it does anything, so a name is only put into a path below once it has been found.

// A form that was refused gets back what was typed, because React empties the form when its action is done.
export async function createServiceAction(projectName: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  const { db, actor } = await beginAction()
  let typed: Record<string, string> = {}
  let result: Awaited<ReturnType<typeof doCreateService>>
  try {
    typed = formTexts(formData, CREATE_FIELDS)
    result = await doCreateService(db, actor, projectName, typed, webConfig())
  } catch (error) {
    return { ...actionError(error, 'creating service'), values: typed }
  }
  if (!('service' in result)) return { ...result, values: typed }
  revalidatePath(projectPath(result.service.projectName))
  revalidatePath('/')
  redirect(servicePath(result.service.projectName, result.service.name))
}

// The settings form has two submit buttons: `intent=save-deploy` (also what Enter in a field presses) and
// `intent=save-only`.
export async function saveServiceSettingsAction(
  projectName: string,
  serviceName: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAction()
  let typed: Record<string, string> = {}
  let result: ActionState
  try {
    typed = formTexts(formData, SERVICE_FIELDS)
    const input = { ...typed, intent: formText(formData, 'intent') }
    result = await doSaveServiceSettings(db, actor, projectName, serviceName, input, webConfig())
  } catch (error) {
    return { ...actionError(error, 'saving service settings'), values: typed }
  }
  if (result.error || result.fieldErrors) return { ...result, values: typed }
  revalidatePath(servicePath(projectName, serviceName))
  revalidatePath(projectPath(projectName))
  return result
}

export async function deleteServiceAction(
  projectName: string,
  serviceName: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAction()
  let result: ActionState
  try {
    result = await doDeleteService(db, actor, projectName, serviceName, { confirm: formText(formData, 'confirm') }, webConfig())
  } catch (error) {
    return actionError(error, 'deleting service')
  }
  if (result.error || result.fieldErrors) return result
  revalidatePath(projectPath(projectName))
  revalidatePath('/')
  redirect(projectPath(projectName))
}
