'use server'

import { revalidatePath } from 'next/cache'
import type { ActionState } from '../action-state'
import { webConfig } from '../config'
import { doDeploy, doRestart, doRollback } from '../deployments'
import { actionError } from '../errors'
import { beginAction } from '../guards'

export type { ActionState } from '../action-state'

const projectPath = (projectName: string) => `/projects/${projectName}`
const servicePath = (projectName: string, serviceName: string) => `${projectPath(projectName)}/services/${serviceName}`

// The names and the deployment id bound to an action by its page come from the browser. The logic looks them up
// before it does anything, and an action whose lookup fails throws before it gets to `refreshed`, so a name is only
// put into a path once it has been found.
function refreshed(projectName: string, serviceName: string, result: ActionState): ActionState {
  if (!result.error) {
    // The service page lists the deployments; the project page and the service's header show the latest status.
    revalidatePath(servicePath(projectName, serviceName))
    revalidatePath(projectPath(projectName))
  }
  return result
}

// All three are used as the action of a button: `deployAction.bind(null, projectName, serviceName)`, and
// `rollbackAction.bind(null, projectName, serviceName, deploymentId)`. There is no form data to read.
export async function deployAction(
  projectName: string,
  serviceName: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAction()
  try {
    return refreshed(projectName, serviceName, await doDeploy(db, actor, projectName, serviceName, webConfig()))
  } catch (error) {
    return actionError(error, 'deploying')
  }
}

export async function restartAction(
  projectName: string,
  serviceName: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAction()
  try {
    return refreshed(projectName, serviceName, await doRestart(db, actor, projectName, serviceName, webConfig()))
  } catch (error) {
    return actionError(error, 'restarting')
  }
}

export async function rollbackAction(
  projectName: string,
  serviceName: string,
  deploymentId: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { db, actor } = await beginAction()
  try {
    return refreshed(projectName, serviceName, await doRollback(db, actor, projectName, serviceName, deploymentId, webConfig()))
  } catch (error) {
    return actionError(error, 'rolling back')
  }
}
