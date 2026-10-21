import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  BuildConfig,
  DeployConfig,
  DeploymentStatus,
  DeploymentTrigger,
  SourceConfig,
} from '@vpsm/core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
})

export const environments = pgTable(
  'environments',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('environments_project_id_name_unique').on(t.projectId, t.name)],
)

export const services = pgTable(
  'services',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<'app' | 'postgres' | 'redis'>().notNull().default('app'),
    canvasX: integer('canvas_x').notNull().default(0),
    canvasY: integer('canvas_y').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('services_project_id_name_unique').on(t.projectId, t.name),
    check('services_kind_check', sql`${t.kind} in ('app', 'postgres', 'redis')`),
  ],
)

export const serviceInstances = pgTable(
  'service_instances',
  {
    id: id(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    source: jsonb('source').$type<SourceConfig>(),
    build: jsonb('build').$type<BuildConfig>().notNull(),
    deploy: jsonb('deploy').$type<DeployConfig>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('service_instances_service_id_environment_id_unique').on(t.serviceId, t.environmentId)],
)

export const deployments = pgTable(
  'deployments',
  {
    id: id(),
    serviceInstanceId: uuid('service_instance_id')
      .notNull()
      .references(() => serviceInstances.id, { onDelete: 'cascade' }),
    status: text('status').$type<DeploymentStatus>().notNull().default('QUEUED'),
    trigger: text('trigger').$type<DeploymentTrigger>().notNull(),
    commitSha: text('commit_sha'),
    commitMessage: text('commit_message'),
    imageTag: text('image_tag'),
    containerName: text('container_name'),
    rollbackOfId: uuid('rollback_of_id').references((): AnyPgColumn => deployments.id),
    configSnapshot: jsonb('config_snapshot'),
    failureReason: text('failure_reason'),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('deployments_status_created_at_idx').on(t.status, t.createdAt),
    index('deployments_service_instance_id_created_at_idx').on(t.serviceInstanceId, t.createdAt.desc().nullsFirst()),
  ],
)

export const deploymentLogs = pgTable(
  'deployment_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    phase: text('phase').$type<'build' | 'deploy'>().notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    line: text('line').notNull(),
  },
  (t) => [
    index('deployment_logs_deployment_id_id_idx').on(t.deploymentId, t.id),
    check('deployment_logs_phase_check', sql`${t.phase} in ('build', 'deploy')`),
  ],
)

export const domains = pgTable(
  'domains',
  {
    id: id(),
    serviceInstanceId: uuid('service_instance_id')
      .notNull()
      .references(() => serviceInstances.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull().unique(),
    kind: text('kind').$type<'generated' | 'custom'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [check('domains_kind_check', sql`${t.kind} in ('generated', 'custom')`)],
)

export type Project = typeof projects.$inferSelect
export type Environment = typeof environments.$inferSelect
export type Service = typeof services.$inferSelect
export type ServiceInstance = typeof serviceInstances.$inferSelect
export type Deployment = typeof deployments.$inferSelect
export type Domain = typeof domains.$inferSelect
