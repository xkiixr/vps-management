import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type BuildConfig,
  checkMemoryBudget,
  containerName,
  type DeployConfig,
  type DeploymentStatus,
  imageTag,
  networkName,
  privateHostname,
  publicUrl,
  type SourceConfig,
  systemEnv,
} from '@vpsm/core'
import {
  type Db,
  type Deployment,
  type DeploymentContext,
  type DeploymentPatch,
  loadDeploymentContext,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import type { buildImage } from '../build/build-image'
import type { chooseBuilder } from '../build/choose-builder'
import { BuildError } from '../build/errors'
import type { railpackPrepare } from '../build/railpack'
import type { WorkerConfig } from '../config'
import type { LineHandler, RunCommand } from '../exec'
import { buildContainerSpec, resourceLimitError } from '../runtime/container-spec'
import type { DockerRuntime } from '../runtime/docker-runtime'
import { type HealthMode, healthMode, type waitHealthy } from '../runtime/healthcheck'
import { type fetchSource, githubCloneUrl, SourceError } from '../source/fetch-source'
import { createLogSink, type LogPhase } from './log-sink'

export type PipelineDeps = {
  db: Db
  docker: DockerRuntime
  config: WorkerConfig
  run: RunCommand
  sleep: (ms: number) => Promise<void>
  fetchSource: typeof fetchSource
  chooseBuilder: typeof chooseBuilder
  railpackPrepare: typeof railpackPrepare
  buildImage: typeof buildImage
  waitHealthy: typeof waitHealthy
  regenerateRoutes: () => Promise<void>
  cleanupImages: (serviceInstanceId: string) => Promise<void>
}

type Builder = 'railpack' | 'dockerfile'

/**
 * Stored as the deployment's `configSnapshot`; a rollback runs exactly this again. `builder` is the one
 * actually used (the config may say `auto`): it decides whether `startCommand` overrides the image CMD.
 */
type ConfigSnapshot = { source: SourceConfig | null; build: BuildConfig; deploy: DeployConfig; builder: Builder }

type Image = { tag: string; snapshot: ConfigSnapshot }

/** Gives Traefik time to pick up the rewritten routes file before the drain starts. */
const ROUTES_RELOAD_MS = 3000
const OLD_CONTAINER_STOP_TIMEOUT_SEC = 30
/** Upper bound for the healthcheck that runs again after the private alias was attached. */
const REPROBE_TIMEOUT_MS = 30_000

/** A failure whose message is written for the user, like SourceError and BuildError. */
class DeploymentFailure extends Error {}

type Job = {
  ctx: DeploymentContext
  deps: PipelineDeps
  /** `${workDir}/${deploymentId}`: checkout and railpack plan; deleted when the job ends. */
  dir: string
  status: DeploymentStatus
  /** The container this job started, removed again if the deployment fails. */
  container?: string
  log(phase: LogPhase, text: string): void
  redact(text: string): string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Builds (or, for a rollback, reuses) the image, starts it next to the live container, waits until it is
 * healthy, switches the routes to it and only then retires the old one. Never throws: any failure before
 * the switch leaves the old container untouched, removes the new one and marks the deployment FAILED.
 */
export async function runDeployment(deploymentId: string, deps: PipelineDeps): Promise<void> {
  const token = deps.config.githubToken
  const redact = (text: string) => (token ? text.replaceAll(token, '***') : text)
  let ctx: DeploymentContext
  try {
    ctx = await loadDeploymentContext(deps.db, deploymentId)
  } catch (error) {
    const message = redact(messageOf(error))
    console.error(`deployment ${deploymentId}: could not load it: ${message}`)
    // It is claimed, so the loop would never pick it up again. Best effort: the database may be what failed.
    await setDeploymentStatus(deps.db, deploymentId, 'FAILED', { failureReason: `internal error: ${message}` }).catch(
      () => undefined,
    )
    return
  }
  if (ctx.deployment.status !== 'QUEUED') {
    console.error(`deployment ${deploymentId}: expected QUEUED but it is ${ctx.deployment.status}; leaving it alone`)
    return
  }

  const sink = createLogSink(deps.db, ctx.deployment.id)
  const job: Job = {
    ctx,
    deps,
    dir: path.join(deps.config.workDir, ctx.deployment.id),
    status: 'QUEUED',
    log: (phase, text) => sink.line(phase, redact(text)),
    redact,
  }
  try {
    await execute(job)
  } catch (error) {
    await handleFailure(job, error)
  } finally {
    // Also after a failed clone, which can leave the token behind in .git/config.
    await fs.rm(job.dir, { recursive: true, force: true }).catch((error) => {
      console.error(`deployment ${deploymentId}: could not remove ${job.dir}: ${messageOf(error)}`)
    })
    await sink.close()
  }
}

async function execute(job: Job): Promise<void> {
  const target = job.ctx.deployment.trigger === 'rollback' ? rollbackTarget(job.ctx) : undefined
  await checkResources(job, target?.snapshot.deploy ?? job.ctx.instance.deploy)
  const image = target ? await startRollback(job, target) : await buildPhase(job)
  const name = await runPhase(job, image)
  await switchPhase(job, name)
}

async function transition(job: Job, to: DeploymentStatus, patch?: DeploymentPatch): Promise<void> {
  await setDeploymentStatus(job.deps.db, job.ctx.deployment.id, to, patch)
  job.status = to
}

/** Refuses limits Docker would not apply, and a deployment that does not fit the memory budget, before cloning. */
async function checkResources(job: Job, deploy: DeployConfig): Promise<void> {
  // buildContainerSpec refuses these too, but only after the whole build.
  const invalid = resourceLimitError(deploy)
  if (invalid !== undefined) throw new DeploymentFailure(invalid)

  const { docker, config } = job.deps
  const running = (await docker.listManaged()).filter((c) => c.running).map((c) => c.memoryMb)
  const budget = checkMemoryBudget({
    runningMb: running,
    newMb: deploy.memoryLimitMB,
    budgetMb: config.memoryBudgetMb,
    maxServiceMb: config.maxServiceMemoryMb,
  })
  if (!budget.ok) throw new DeploymentFailure(budget.reason)
}

type RollbackTarget = { source: Deployment; tag: string; snapshot: ConfigSnapshot }

function rollbackTarget(ctx: DeploymentContext): RollbackTarget {
  const source = ctx.rollbackSource
  if (!source) throw new DeploymentFailure('rollback target not found')
  const snapshot = source.configSnapshot as Partial<ConfigSnapshot> | null
  if (!source.imageTag || typeof snapshot?.deploy !== 'object' || snapshot.deploy === null) {
    throw new DeploymentFailure('rollback target has no built image')
  }
  return { source, tag: source.imageTag, snapshot: snapshot as ConfigSnapshot }
}

async function startRollback(job: Job, target: RollbackTarget): Promise<Image> {
  if (!(await job.deps.docker.imageExists(target.tag))) {
    throw new DeploymentFailure('image for rollback target no longer exists')
  }
  job.log('deploy', `==> Rolling back to deployment ${target.source.id.slice(0, 8)} (image ${target.tag})`)
  await transition(job, 'DEPLOYING', {
    imageTag: target.tag,
    configSnapshot: target.source.configSnapshot,
    commitSha: target.source.commitSha ?? undefined,
    commitMessage: target.source.commitMessage ?? undefined,
  })
  return { tag: target.tag, snapshot: target.snapshot }
}

async function buildPhase(job: Job): Promise<Image> {
  const { deps, ctx } = job
  const { source, build, deploy } = ctx.instance
  const token = deps.config.githubToken
  const onLine: LineHandler = (line) => job.log('build', line)

  await transition(job, 'BUILDING')
  if (!source) throw new SourceError('service has no source repository')
  job.log('build', `==> Cloning ${source.repo}@${source.branch}`)
  await fs.mkdir(job.dir, { recursive: true })
  const fetched = await deps.fetchSource({
    cloneUrl: githubCloneUrl(source.repo, token),
    branch: source.branch,
    commitSha: ctx.deployment.commitSha ?? undefined,
    rootDirectory: source.rootDirectory,
    destDir: path.join(job.dir, 'src'),
    onLine,
    redact: token ? [token] : [],
    run: deps.run,
  })

  // chooseBuilder also refuses a dockerfilePath that escapes the repository through a symlink.
  const builder = await deps.chooseBuilder(fetched.contextDir, build)
  job.log('build', `==> Building with ${builder}`)
  const planPath =
    builder === 'railpack'
      ? (
          await deps.railpackPrepare({
            contextDir: fetched.contextDir,
            outDir: job.dir,
            build,
            startCommand: deploy.startCommand,
            onLine,
            run: deps.run,
            sleep: deps.sleep,
          })
        ).planPath
      : undefined
  const tag = imageTag(ctx.instance.id, ctx.deployment.id)
  await deps.buildImage({
    builder,
    contextDir: fetched.contextDir,
    planPath,
    dockerfilePath: build.dockerfilePath,
    tag,
    cacheKey: ctx.instance.id,
    frontendImage: deps.config.frontendImage,
    timeoutMs: deps.config.buildTimeoutMs,
    onLine,
    run: deps.run,
  })

  const snapshot: ConfigSnapshot = { source, build, deploy, builder }
  await transition(job, 'DEPLOYING', {
    commitSha: fetched.commitSha,
    commitMessage: fetched.commitMessage,
    imageTag: tag,
    configSnapshot: snapshot,
  })
  return { tag, snapshot }
}

function describeHealth(mode: HealthMode, deploy: DeployConfig): string {
  switch (mode) {
    case 'http':
      return `http ${deploy.healthcheckPath}`
    case 'tcp':
      return `tcp port ${deploy.port}`
    case 'running':
      return 'container keeps running'
  }
}

/** Starts the new container next to the live one and waits until it is healthy. Returns its name. */
async function runPhase(job: Job, image: Image): Promise<string> {
  const { deps, ctx } = job
  const { docker, config } = deps
  const { deploy, builder } = image.snapshot
  const net = networkName(ctx.environment.id)
  await docker.ensureNetwork(net)
  // Traefik routes to the container and the worker probes it, both by its name on this network.
  await docker.connect(config.traefikContainer, net)
  await docker.connect(config.workerContainer, net)

  const name = containerName(ctx.service.name, ctx.deployment.id)
  const publicHostname = publicHostnameOf(ctx)
  const spec = buildContainerSpec({
    name,
    image: image.tag,
    env: systemEnv({ port: deploy.port, serviceName: ctx.service.name, projectName: ctx.project.name, publicHostname }),
    deploy,
    // A railpack image already has the start command baked in.
    cmd: builder === 'dockerfile' && deploy.startCommand ? ['sh', '-c', deploy.startCommand] : undefined,
    networkName: net,
    // No alias yet: until it is healthy, `<service>.internal` must keep resolving only to the live container.
    aliases: [],
    deploymentId: ctx.deployment.id,
    serviceInstanceId: ctx.instance.id,
  })
  job.log('deploy', '==> Starting container')
  await docker.run(spec)
  job.container = name

  const mode = healthMode(deploy, ctx.domains.length > 0)
  const target = { host: name, port: deploy.port, path: deploy.healthcheckPath, mode }
  const state = () => docker.state(name)
  const timeoutMs = deploy.healthcheckTimeoutSec * 1000
  job.log('deploy', `==> Healthcheck (${describeHealth(mode, deploy)})`)
  const health = await deps.waitHealthy(target, { timeoutMs, state })
  if (!health.ok) throw new DeploymentFailure(health.reason)

  const alias = privateHostname(ctx.service.name)
  await docker.attachAlias(name, net, [alias])
  // Attaching the alias disconnects and reconnects the container, which can change its IP and drop its
  // connections (an app bound to one address, like a Next.js standalone server, may stop answering).
  job.log('deploy', `==> Healthcheck again after attaching ${alias}`)
  const again = await deps.waitHealthy(target, { timeoutMs: Math.min(REPROBE_TIMEOUT_MS, timeoutMs), state })
  if (!again.ok) throw new DeploymentFailure(again.reason)
  return name
}

/** Waits between attempts to write the routes: 3 attempts in all. */
const ROUTES_RETRY_DELAYS_MS = [1000, 2000]

async function regenerateRoutesWithRetry(job: Job): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await job.deps.regenerateRoutes()
    } catch (error) {
      const delay = ROUTES_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) throw error
      job.log('deploy', `==> Updating routes failed, retrying in ${delay / 1000}s: ${messageOf(error)}`)
      await job.deps.sleep(delay)
    }
  }
}

const publicHostnameOf = (ctx: DeploymentContext) => ctx.domains.map((d) => d.hostname).sort()[0]

/** Marks the new deployment live, points the routes at it, then drains and stops the old container. */
async function switchPhase(job: Job, name: string): Promise<void> {
  const { deps, ctx } = job
  const { previous } = ctx
  await markDeploymentLive(deps.db, { deploymentId: ctx.deployment.id, containerName: name, previousId: previous?.id })
  job.status = 'SUCCESS'
  await regenerateRoutesWithRetry(job)
  const publicHostname = publicHostnameOf(ctx)
  job.log(
    'deploy',
    publicHostname ? `==> Live at ${publicUrl(publicHostname, deps.config.publicHttpsPort)}` : '==> Live (no public domain)',
  )

  if (previous) {
    await deps.sleep(ROUTES_RELOAD_MS)
    await deps.sleep(deps.config.drainSeconds * 1000)
    if (previous.containerName) {
      job.log('deploy', `==> Stopping previous container ${previous.containerName}`)
      await deps.docker.stopAndRemove(previous.containerName, OLD_CONTAINER_STOP_TIMEOUT_SEC)
    }
  }
  await deps.cleanupImages(ctx.instance.id)
}

async function handleFailure(job: Job, error: unknown): Promise<void> {
  const { deps, ctx } = job
  const report = (text: string) => console.error(`deployment ${ctx.deployment.id}: ${job.redact(text)}`)
  const userFacing = error instanceof SourceError || error instanceof BuildError || error instanceof DeploymentFailure
  const reason = job.redact(userFacing ? error.message : `internal error: ${messageOf(error)}`)

  if (job.status === 'SUCCESS') {
    // Already live; a later step failed (routes, drain, stopping the old container, image cleanup). If the
    // routes were not rewritten Traefik still points at the old container, which is why it was not stopped.
    job.log('deploy', `==> Post-deploy step failed: ${reason}`)
    report(`post-deploy step failed: ${reason}`)
    return
  }

  job.log(job.status === 'BUILDING' ? 'build' : 'deploy', `==> Deployment failed: ${reason}`)
  if (job.container) {
    await deps.docker.stopAndRemove(job.container, 0).catch((e) => report(`could not remove ${job.container}: ${messageOf(e)}`))
  }
  // QUEUED, BUILDING and DEPLOYING may all move to FAILED.
  await setDeploymentStatus(deps.db, ctx.deployment.id, 'FAILED', { failureReason: reason }).catch((e) =>
    report(`could not mark it FAILED (${reason}): ${messageOf(e)}`),
  )
}
