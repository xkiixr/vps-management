import { type ServiceInput, validateName, validateServiceInput } from '@vpsm/core'
import {
  type Actor,
  createAppService,
  type Db,
  deleteService,
  enqueueDeployment,
  findService,
  type Project,
  type ServiceInstance,
  type ServiceRow,
  updateServiceConfig,
  ValidationError,
} from '@vpsm/db'
import type { ActionState, FieldErrors } from './action-state'
import { auditBestEffort } from './audit'
import { logServerError, NotFoundError } from './errors'
import { hasControlCharacters } from './form'
import { maxServiceMemoryMb } from './limits'
import { refusal, visibleProject } from './projects'

// The logic of the service actions, apart from Next (headers, session, redirects), so that it can be tested
// against a database; see ./projects.ts for how this is split from the actions. A project or service the actor
// may not see is NotFoundError, exactly as if it did not exist, and only ids found by those lookups are ever
// handed to the functions of @vpsm/db that check nothing about who is asking.

export const CONFIRM_SERVICE_MESSAGE = 'type the service name to confirm'
export const SAVED_NOTICE = 'Settings saved. They go live with the next deploy.'
export const SAVED_AND_QUEUED_NOTICE = 'Settings saved. A deployment is queued.'

const INVALID_CHARACTERS = 'contains invalid characters'
const NOT_A_WHOLE_NUMBER = 'must be a whole number'

const DEFAULT_BRANCH = 'main'
const DEFAULT_PORT = 8080
const DEFAULT_MEMORY_MB = 512

const STRING_FIELDS = ['repo', 'branch', 'rootDirectory', 'healthcheckPath', 'startCommand'] as const
const NUMBER_FIELDS = ['port', 'memoryLimitMB'] as const
/** The settings of a service, in the order the form shows them (and the order changed ones are recorded in). */
export const SERVICE_FIELDS = [
  'repo',
  'branch',
  'rootDirectory',
  'healthcheckPath',
  'port',
  'memoryLimitMB',
  'startCommand',
] as const
export const CREATE_FIELDS = ['name', ...SERVICE_FIELDS] as const

type ServiceField = (typeof SERVICE_FIELDS)[number]

/** What the new-service form submits, as text. A field that was not submitted is absent. */
export type CreateServiceInput = Partial<Record<(typeof CREATE_FIELDS)[number], string>>
/** What the settings form submits, as text. A field that was not submitted is left as it is. */
export type SettingsInput = Partial<Record<ServiceField, string>> & {
  /** `save-only` saves without deploying; anything else (the default) saves and deploys. */
  intent?: string
}

/** Where the dashboard is served from: the generated address of a service is `<service>-<project>.<appsDomain>`. */
export type Site = { appsDomain: string; httpsPort: number }

async function visibleService(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  httpsPort: number,
): Promise<{ project: Project; row: ServiceRow }> {
  const project = await visibleProject(db, actor, projectName)
  // The name of a bound action argument comes from the browser and is not guaranteed to be text.
  const row = typeof serviceName === 'string' ? await findService(db, project.id, serviceName, { httpsPort }) : null
  if (!row) throw new NotFoundError()
  return { project, row }
}

// A number typed into a form: digits only, so no sign, fraction, exponent, unit or other script's digits.
// Anything else is NaN, which validateServiceInput always refuses, together with what to tell the user instead.
function wholeNumber(typed: string): { value: number; problem?: string } {
  const text = typed.trim()
  if (/^\d+$/.test(text)) return { value: Number(text) }
  return { value: Number.NaN, problem: hasControlCharacters(text) ? INVALID_CHARACTERS : NOT_A_WHOLE_NUMBER }
}

export type CreateServiceResult =
  | { service: { id: string; name: string; projectName: string } }
  | { fieldErrors: FieldErrors }

/**
 * Creates a service in the project from the new-service form, queues its first deployment and records
 * service.create. Creating has no normaliser in the database layer (updating has), so it is done here: text is
 * trimmed, blank optional fields are left out, the branch, port and memory have defaults, and numbers must be
 * plain digits. Nothing is created or queued unless every field is valid.
 */
export async function doCreateService(
  db: Db,
  actor: Actor,
  projectName: string,
  input: CreateServiceInput,
  site: Site,
): Promise<CreateServiceResult> {
  const project = await visibleProject(db, actor, projectName)
  const limits = { maxServiceMemoryMb: await maxServiceMemoryMb(db) }

  const text = Object.fromEntries(CREATE_FIELDS.map((field) => [field, (input[field] ?? '').trim()])) as Record<
    (typeof CREATE_FIELDS)[number],
    string
  >
  const orNothing = (value: string) => (value === '' ? undefined : value)
  const branch = text.branch === '' ? DEFAULT_BRANCH : text.branch
  const port = text.port === '' ? { value: DEFAULT_PORT } : wholeNumber(text.port)
  const memory = text.memoryLimitMB === '' ? { value: DEFAULT_MEMORY_MB } : wholeNumber(text.memoryLimitMB)
  const rootDirectory = orNothing(text.rootDirectory)
  const healthcheckPath = orNothing(text.healthcheckPath)
  const startCommand = orNothing(text.startCommand)

  const nameCheck = text.name === '' ? { ok: false as const, reason: 'name is required' } : validateName(text.name)
  const fieldErrors: FieldErrors = {
    ...validateServiceInput(
      { repo: text.repo, branch, rootDirectory, healthcheckPath, port: port.value, memoryLimitMB: memory.value, startCommand },
      limits,
    ),
    ...(nameCheck.ok ? {} : { name: nameCheck.reason }),
    ...(port.problem === undefined ? {} : { port: port.problem }),
    ...(memory.problem === undefined ? {} : { memoryLimitMB: memory.problem }),
  }
  // Last, so that it wins over the message of whichever check the same character would also fail.
  for (const field of CREATE_FIELDS) if (hasControlCharacters(text[field])) fieldErrors[field] = INVALID_CHARACTERS
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors }

  let created: Awaited<ReturnType<typeof createAppService>>
  try {
    created = await createAppService(db, {
      projectName: project.name,
      serviceName: text.name,
      source: { repo: text.repo, branch, ...(rootDirectory === undefined ? {} : { rootDirectory }) },
      deploy: {
        port: port.value,
        memoryLimitMB: memory.value,
        ...(healthcheckPath === undefined ? {} : { healthcheckPath }),
        ...(startCommand === undefined ? {} : { startCommand }),
      },
      appsDomain: site.appsDomain,
    })
  } catch (error) {
    // The name is the one input that can clash: with a service of the project, or with another generated address.
    if (error instanceof ValidationError) return { fieldErrors: { name: error.message } }
    throw error
  }

  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'service.create',
    targetType: 'service',
    targetId: created.service.id,
    metadata: { project: project.name, service: created.service.name, repo: text.repo },
  })
  // The service exists now, so it is reported even if it could not be queued: trying again would only say that
  // the name is taken. Its page offers the deploy.
  try {
    await enqueueDeployment(db, { serviceInstanceId: created.instance.id, trigger: 'manual', createdById: actor.id })
  } catch (error) {
    logServerError('queuing the first deployment', error)
  }
  return { service: { id: created.service.id, name: created.service.name, projectName: project.name } }
}

// The settings as the form shows them.
function settingsOf(instance: ServiceInstance): Record<ServiceField, string | number | undefined> {
  return {
    repo: instance.source?.repo,
    branch: instance.source?.branch,
    rootDirectory: instance.source?.rootDirectory,
    healthcheckPath: instance.deploy.healthcheckPath,
    port: instance.deploy.port,
    memoryLimitMB: instance.deploy.memoryLimitMB,
    startCommand: instance.deploy.startCommand,
  }
}

/**
 * Saves the settings form. updateServiceConfig does the trimming (a blank optional field removes the setting)
 * and the checks, and nothing is saved unless every field is valid. Unless the intent is `save-only`, a
 * deployment with the settings is queued (trigger `config`), also when nothing changed, because the settings may
 * have been saved earlier with `save-only`. service.update names the fields that changed, never their values.
 */
export async function doSaveServiceSettings(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  input: SettingsInput,
  site: Pick<Site, 'httpsPort'>,
): Promise<ActionState> {
  const { project, row } = await visibleService(db, actor, projectName, serviceName, site.httpsPort)
  const limits = { maxServiceMemoryMb: await maxServiceMemoryMb(db) }

  const patch: ServiceInput = {}
  const notNumbers: FieldErrors = {}
  for (const field of STRING_FIELDS) if (input[field] !== undefined) patch[field] = input[field]
  for (const field of NUMBER_FIELDS) {
    const typed = input[field]
    if (typed === undefined) continue
    const number = wholeNumber(typed)
    // A NaN is refused by the checks in updateServiceConfig, which then saves nothing and still checks the
    // other fields; the message it gives for a number that is not one is replaced below.
    patch[field] = number.value
    if (number.problem !== undefined) notNumbers[field] = number.problem
  }

  let updated: Awaited<ReturnType<typeof updateServiceConfig>>
  try {
    updated = await updateServiceConfig(db, row.instance.id, patch, limits)
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message }
    throw error
  }
  if (!updated.ok) return { fieldErrors: { ...updated.errors, ...notNumbers } }

  const saved = await findService(db, project.id, row.service.name, { httpsPort: site.httpsPort })
  const before = settingsOf(row.instance)
  const after = saved ? settingsOf(saved.instance) : before
  const changed = SERVICE_FIELDS.filter((field) => before[field] !== after[field])
  if (changed.length > 0) {
    await auditBestEffort(db, {
      actorId: actor.id,
      action: 'service.update',
      targetType: 'service',
      targetId: row.service.id,
      metadata: { project: project.name, service: row.service.name, fields: changed },
    })
  }

  if (input.intent === 'save-only') return { notice: SAVED_NOTICE }
  await enqueueDeployment(db, { serviceInstanceId: row.instance.id, trigger: 'config', createdById: actor.id })
  return { notice: SAVED_AND_QUEUED_NOTICE }
}

/** Deletes the service when its name is typed in `confirm`. */
export async function doDeleteService(
  db: Db,
  actor: Actor,
  projectName: string,
  serviceName: string,
  input: { confirm?: string },
  site: Pick<Site, 'httpsPort'>,
): Promise<ActionState> {
  const { project, row } = await visibleService(db, actor, projectName, serviceName, site.httpsPort)
  if ((input.confirm ?? '').trim() !== row.service.name) return { error: CONFIRM_SERVICE_MESSAGE }

  const failed = await refusal(() => deleteService(db, row.instance.id))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'service.delete',
    targetType: 'service',
    targetId: row.service.id,
    metadata: { project: project.name, service: row.service.name },
  })
  return {}
}
