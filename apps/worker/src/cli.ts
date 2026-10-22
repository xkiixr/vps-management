import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import type { DeploymentTrigger } from '@vpsm/core'
import {
  createAppService,
  createDb,
  createProject,
  type Db,
  deploymentLogs,
  deployments,
  enqueueDeployment,
  findServiceInstance,
  projects,
  services,
} from '@vpsm/db'
import { loadConfig, type WorkerConfig } from './config'
import { createDockerRuntime, type DockerRuntime } from './runtime/docker-runtime'

export type CliDeps = { db: Db; docker: DockerRuntime; config: WorkerConfig; out: (line: string) => void }

/** An error that is reported to the operator as `error: <message>`. */
class CliError extends Error {}
/** A `CliError` after which the usage is printed too. */
class UsageError extends CliError {}

const OPTIONS = {
  repo: { type: 'string' },
  branch: { type: 'string' },
  root: { type: 'string' },
  healthcheck: { type: 'string' },
  port: { type: 'string' },
  memory: { type: 'string' },
  start: { type: 'string' },
  help: { type: 'boolean' },
} as const

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']
type Context = CliDeps & { args: string[]; flags: Flags }
type Command = { args: string[]; flags?: string; run(c: Context): Promise<void> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PORT = 65535

/** The message of the innermost cause (drivers wrap their errors), first line only. */
function messageOf(error: unknown): string {
  let e = error
  while (e instanceof Error && e.cause instanceof Error) e = e.cause
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!
}

function positiveInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
    throw new CliError(`${flag} must be a positive integer`)
  }
  return n
}

async function requireInstance(db: Db, project: string, service: string) {
  const found = await findServiceInstance(db, project, service)
  if (!found) throw new CliError(`service ${project}/${service} not found`)
  return found
}

async function enqueue(c: Context, serviceInstanceId: string, trigger: DeploymentTrigger, rollbackOfId?: string) {
  const queued = await enqueueDeployment(c.db, { serviceInstanceId, trigger, rollbackOfId })
  c.out(`queued deployment ${queued.id}`)
}

const COMMANDS: Record<string, Command> = {
  'project:create': {
    args: ['project'],
    async run({ db, out, args: [project] }) {
      await createProject(db, project!)
      out(`created project ${project}`)
    },
  },

  'service:create': {
    args: ['project', 'service'],
    flags:
      '--repo <owner/name> --branch <branch> [--root <dir>] [--healthcheck <path>] [--port <n>] [--memory <mb>] [--start <cmd>]',
    async run(c) {
      const [project, service] = c.args
      const { repo, branch, root, healthcheck, start } = c.flags
      if (repo === undefined) throw new UsageError('--repo is required')
      if (branch === undefined) throw new UsageError('--branch is required')
      const port = positiveInt('--port', c.flags.port)
      const memory = positiveInt('--memory', c.flags.memory)
      if (port !== undefined && port > MAX_PORT) throw new CliError(`--port must be at most ${MAX_PORT}`)
      if (memory !== undefined && memory > c.config.maxServiceMemoryMb) {
        throw new CliError(`--memory exceeds the per-service max of ${c.config.maxServiceMemoryMb} MB`)
      }

      const { instance, domain } = await createAppService(c.db, {
        projectName: project!,
        serviceName: service!,
        source: { repo, branch, ...(root === undefined ? {} : { rootDirectory: root }) },
        deploy: { healthcheckPath: healthcheck, port, memoryLimitMB: memory, startCommand: start },
        appsDomain: c.config.appsDomain,
      })
      c.out(`https://${domain.hostname}`)
      await enqueue(c, instance.id, 'manual')
    },
  },

  deploy: {
    args: ['project', 'service'],
    async run(c) {
      const { instance } = await requireInstance(c.db, c.args[0]!, c.args[1]!)
      await enqueue(c, instance.id, 'manual')
    },
  },

  rollback: {
    args: ['project', 'service', 'deploymentId'],
    async run(c) {
      const [project, service, id] = c.args as [string, string, string]
      const { instance } = await requireInstance(c.db, project, service)
      const [target] = UUID.test(id)
        ? await c.db
            .select()
            .from(deployments)
            .where(and(eq(deployments.id, id), eq(deployments.serviceInstanceId, instance.id)))
        : []
      if (!target) throw new CliError(`deployment does not belong to ${project}/${service}`)
      if (!target.imageTag) throw new CliError(`deployment ${id} has no image to roll back to`)
      await enqueue(c, instance.id, 'rollback', target.id)
    },
  },

  restart: {
    args: ['project', 'service'],
    async run({ db, docker, out, args: [project, service] }) {
      const { instance } = await requireInstance(db, project!, service!)
      const [live] = await db
        .select({ containerName: deployments.containerName })
        .from(deployments)
        .where(
          and(
            eq(deployments.serviceInstanceId, instance.id),
            eq(deployments.status, 'SUCCESS'),
            isNotNull(deployments.containerName),
          ),
        )
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1)
      if (!live?.containerName) throw new CliError(`${project}/${service} has no running deployment`)
      await docker.restart(live.containerName)
      out(`restarted ${project}/${service}`)
    },
  },

  status: {
    args: ['project'],
    async run({ db, out, args: [project] }) {
      const [found] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, project!))
      if (!found) throw new CliError(`project ${project} not found`)

      const rows = await db
        .select({ name: services.name })
        .from(services)
        .where(eq(services.projectId, found.id))
        .orderBy(asc(services.name))
      for (const { name } of rows) {
        const details = await findServiceInstance(db, project!, name)
        const [latest] = details
          ? await db
              .select({ status: deployments.status })
              .from(deployments)
              .where(eq(deployments.serviceInstanceId, details.instance.id))
              .orderBy(desc(deployments.createdAt), desc(deployments.id))
              .limit(1)
          : []
        const domain = details?.domains.find((d) => d.kind === 'generated')
        out(`${name}  ${latest?.status ?? '-'}  ${domain ? `https://${domain.hostname}` : '-'}`)
      }
    },
  },

  logs: {
    args: ['deploymentId'],
    async run({ db, out, args: [id] }) {
      const [found] = UUID.test(id!)
        ? await db.select({ id: deployments.id }).from(deployments).where(eq(deployments.id, id!))
        : []
      if (!found) throw new CliError(`deployment ${id} not found`)

      const lines = await db
        .select({ line: deploymentLogs.line })
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, found.id))
        .orderBy(asc(deploymentLogs.id))
      for (const { line } of lines) out(line)
    },
  },
}

/** parseArgs rejects unknown options and options without a value. */
const isBadArguments = (error: unknown) => String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS_')

const usageOf = (name: string, c: Command) =>
  [name, ...c.args.map((a) => `<${a}>`), ...(c.flags ? [c.flags] : [])].join(' ')

function printUsage(out: (line: string) => void): void {
  out('usage:')
  for (const [name, command] of Object.entries(COMMANDS)) out(`  ${usageOf(name, command)}`)
}

/** Runs one CLI command; returns the process exit code (0 on success, 1 on any error). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
    const [name, ...args] = parsed.positionals
    if (parsed.values.help) {
      printUsage(deps.out)
      return 0
    }
    if (name === undefined) throw new UsageError('missing command')
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name]! : undefined
    if (!command) throw new UsageError(`unknown command "${name}"`)
    if (args.length !== command.args.length) throw new UsageError(`expected: ${usageOf(name, command)}`)
    if (!command.flags && Object.keys(parsed.values).length > 0) throw new UsageError(`${name} takes no options`)

    await command.run({ ...deps, args, flags: parsed.values })
    return 0
  } catch (error) {
    deps.out(`error: ${messageOf(error)}`)
    if (error instanceof UsageError || isBadArguments(error)) printUsage(deps.out)
    return 1
  }
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const config = loadConfig()
  const { db, close } = createDb(databaseUrl)
  try {
    const deps = { db, docker: createDockerRuntime(), config, out: (line: string) => console.log(line) }
    return await runCli(process.argv.slice(2), deps)
  } finally {
    await close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`error: ${messageOf(error)}`)
      process.exit(1)
    },
  )
}
