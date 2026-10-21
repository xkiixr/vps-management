import { and, asc, eq } from 'drizzle-orm'
import {
  type BuildConfig,
  DEFAULT_BUILD_CONFIG,
  DEFAULT_DEPLOY_CONFIG,
  type DeployConfig,
  generatedHostname,
  type SourceConfig,
  validateName,
} from '@vpsm/core'
import type { Db } from './client'
import {
  type Domain,
  domains,
  type Environment,
  environments,
  type Project,
  projects,
  type Service,
  type ServiceInstance,
  serviceInstances,
  services,
} from './schema'

const PRODUCTION_ENVIRONMENT = 'production'
const UNIQUE_VIOLATION = '23505'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export type ServiceInstanceDetails = {
  project: Project
  environment: Environment
  service: Service
  instance: ServiceInstance
  domains: Domain[]
}

// Drizzle wraps the driver error; the postgres.js error (with `code` and `constraint_name`) is on `cause`.
function violatedUniqueConstraint(error: unknown): string | undefined {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const { code, constraint_name } = e as { code?: unknown; constraint_name?: unknown }
    if (code === UNIQUE_VIOLATION && typeof constraint_name === 'string') return constraint_name
  }
  return undefined
}

// Optional config overrides may carry explicit `undefined` values; those must not erase defaults.
function withoutUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>
}

export async function createProject(db: Db, name: string): Promise<Project> {
  const validation = validateName(name)
  if (!validation.ok) throw new ValidationError(`invalid project name "${name}": ${validation.reason}`)

  try {
    return await db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({ name }).returning()
      await tx.insert(environments).values({ projectId: project!.id, name: PRODUCTION_ENVIRONMENT })
      return project!
    })
  } catch (error) {
    if (violatedUniqueConstraint(error) === 'projects_name_unique') {
      throw new ValidationError(`project "${name}" already exists`)
    }
    throw error
  }
}

export async function createAppService(
  db: Db,
  i: {
    projectName: string
    serviceName: string
    source: SourceConfig
    build?: Partial<BuildConfig>
    deploy?: Partial<DeployConfig>
    appsDomain: string
  },
): Promise<{ service: Service; instance: ServiceInstance; domain: Domain }> {
  const validation = validateName(i.serviceName)
  if (!validation.ok) throw new ValidationError(`invalid service name "${i.serviceName}": ${validation.reason}`)

  const hostname = generatedHostname(i.serviceName, i.projectName, i.appsDomain)
  try {
    return await db.transaction(async (tx) => {
      const [environment] = await tx
        .select({ id: environments.id, projectId: environments.projectId })
        .from(environments)
        .innerJoin(projects, eq(environments.projectId, projects.id))
        .where(and(eq(projects.name, i.projectName), eq(environments.name, PRODUCTION_ENVIRONMENT)))
      if (!environment) throw new ValidationError(`project "${i.projectName}" not found`)

      const [service] = await tx
        .insert(services)
        .values({ projectId: environment.projectId, name: i.serviceName, kind: 'app' })
        .returning()
      const [instance] = await tx
        .insert(serviceInstances)
        .values({
          serviceId: service!.id,
          environmentId: environment.id,
          source: i.source,
          build: { ...DEFAULT_BUILD_CONFIG, ...withoutUndefined(i.build) },
          deploy: { ...DEFAULT_DEPLOY_CONFIG, ...withoutUndefined(i.deploy) },
        })
        .returning()
      const [domain] = await tx
        .insert(domains)
        .values({ serviceInstanceId: instance!.id, hostname, kind: 'generated' })
        .returning()
      return { service: service!, instance: instance!, domain: domain! }
    })
  } catch (error) {
    switch (violatedUniqueConstraint(error)) {
      case 'services_project_id_name_unique':
        throw new ValidationError(`service "${i.serviceName}" already exists in project "${i.projectName}"`)
      case 'domains_hostname_unique':
        throw new ValidationError(`hostname ${hostname} is already used by another service`)
      default:
        throw error
    }
  }
}

export async function findServiceInstance(
  db: Db,
  projectName: string,
  serviceName: string,
  environmentName = PRODUCTION_ENVIRONMENT,
): Promise<ServiceInstanceDetails | null> {
  const [row] = await db
    .select({ project: projects, environment: environments, service: services, instance: serviceInstances })
    .from(serviceInstances)
    .innerJoin(services, eq(serviceInstances.serviceId, services.id))
    .innerJoin(environments, eq(serviceInstances.environmentId, environments.id))
    .innerJoin(projects, eq(services.projectId, projects.id))
    .where(
      and(eq(projects.name, projectName), eq(services.name, serviceName), eq(environments.name, environmentName)),
    )
  if (!row) return null

  const instanceDomains = await db
    .select()
    .from(domains)
    .where(eq(domains.serviceInstanceId, row.instance.id))
    .orderBy(asc(domains.createdAt), asc(domains.hostname))
  return { ...row, domains: instanceDomains }
}
