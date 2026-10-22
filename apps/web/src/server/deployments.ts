import { type Actor, type Db, enqueueDeployment, findDeploymentInProject, ValidationError } from '@vpsm/db'
import type { ActionState } from './action-state'
import { auditBestEffort } from './audit'
import { NotFoundError } from './errors'
import { type Site, visibleService } from './services'

// The logic of the deploy, restart and rollback actions, apart from Next (headers, session, redirects); see
// ./projects.ts for how this is split from the actions. Every function starts from visibleService(), so a
// project or service the actor may not see is NotFoundError, exactly as if it did not exist. enqueueDeployment()
// checks nothing about who is asking, so it only gets ids found that way: the instance of the service that was
// found, and a deployment id that findDeploymentInProject() found in the project and that was then checked to
// belong to this very service.
//
// The audit events are named and shaped like the CLI's (deployment.deploy / .rollback): the deployment that was
// queued is the target, and the deployment being restarted or rolled back to is in the metadata.

export const NOTHING_RUNNING_MESSAGE = 'nothing is running to restart'
export const NO_IMAGE_MESSAGE = 'this deployment has no image to roll back to'
export const ALREADY_RUNNING_MESSAGE = 'this deployment is already running — use Restart'
export const DEPLOY_QUEUED_NOTICE = 'Deployment queued.'
export const RESTART_QUEUED_NOTICE = 'Restart queued.'
export const ROLLBACK_QUEUED_NOTICE = 'Rollback queued.'

/** Queues a deployment of the service's current source and settings (trigger `manual`). */
export async function doDeploy(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  site: Pick<Site, 'httpsPort'>,
): Promise<ActionState> {
  const { project, row } = await visibleService(db, actor, projectName, serviceName, site.httpsPort)
  const queued = await enqueueDeployment(db, { serviceInstanceId: row.instance.id, trigger: 'manual', createdById: actor.id })
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'deployment.deploy',
    targetType: 'deployment',
    targetId: queued.id,
    metadata: { project: project.name, service: row.service.name },
  })
  return { notice: DEPLOY_QUEUED_NOTICE }
}

/**
 * Queues a restart: the image of the current deployment is deployed again without downtime (not `docker
 * restart`). The current one is the newest SUCCESS or CRASHED deployment (`row.current`), so a service whose
 * container crashed can be started again; without one there is nothing to restart. The worker restarts whatever
 * is current when the restart runs (its `previous`, picked the same way); the one current now is recorded as
 * `rollbackOfId`. While another deployment is waiting the queue refuses, as a restart must never cancel a deploy,
 * and its message is shown as it is.
 */
export async function doRestart(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  site: Pick<Site, 'httpsPort'>,
): Promise<ActionState> {
  const { project, row } = await visibleService(db, actor, projectName, serviceName, site.httpsPort)
  const { current } = row
  if (!current) return { error: NOTHING_RUNNING_MESSAGE }

  let queued: Awaited<ReturnType<typeof enqueueDeployment>>
  try {
    queued = await enqueueDeployment(db, {
      serviceInstanceId: row.instance.id,
      trigger: 'restart',
      rollbackOfId: current.id,
      createdById: actor.id,
    })
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message }
    throw error
  }
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'deployment.restart',
    targetType: 'deployment',
    targetId: queued.id,
    metadata: { project: project.name, service: row.service.name, rollbackOfId: current.id },
  })
  return { notice: RESTART_QUEUED_NOTICE }
}

/**
 * Queues a rollback: the image of an earlier deployment of this service is deployed again. `deploymentId` comes
 * from the browser. It must be a deployment of this service: one of another service or project is NotFound,
 * with nothing to tell it from an id that does not exist. The one that is live is refused (use Restart), and one
 * of this service that never got an image has nothing to roll back to; both say so.
 */
export async function doRollback(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  deploymentId: string,
  site: Pick<Site, 'httpsPort'>,
): Promise<ActionState> {
  const { project, row } = await visibleService(db, actor, projectName, serviceName, site.httpsPort)
  const target = typeof deploymentId === 'string' ? await findDeploymentInProject(db, project.id, deploymentId) : null
  if (!target || target.serviceInstanceId !== row.instance.id) throw new NotFoundError()
  // Deploying the image that is already live again is what Restart is for. A crashed deployment is not live, so
  // rolling back to it is allowed.
  if (target.id === row.live?.id) return { error: ALREADY_RUNNING_MESSAGE }
  if (!target.imageTag) return { error: NO_IMAGE_MESSAGE }

  const queued = await enqueueDeployment(db, {
    serviceInstanceId: row.instance.id,
    trigger: 'rollback',
    rollbackOfId: target.id,
    createdById: actor.id,
  })
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'deployment.rollback',
    targetType: 'deployment',
    targetId: queued.id,
    metadata: { project: project.name, service: row.service.name, rollbackOfId: target.id },
  })
  return { notice: ROLLBACK_QUEUED_NOTICE }
}
