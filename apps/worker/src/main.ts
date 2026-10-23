import { setTimeout as sleep } from 'node:timers/promises'
import { createDb, migrate } from '@vpsm/db'
import { bootWorker } from './boot'
import { buildImage, ensureBuilder } from './build/build-image'
import { chooseBuilder } from './build/choose-builder'
import { railpackPrepare } from './build/railpack'
import { loadConfig } from './config'
import { startDeployLoop } from './deploy/loop'
import type { PipelineDeps } from './deploy/pipeline'
import { recoverInterruptedDeployments } from './deploy/recovery'
import { runCommand } from './exec'
import { createGithubAppClient, loadGithubAppKey } from './github/app-client'
import { cleanupImages } from './images/retention'
import { startCrashMonitor } from './monitor/crash-monitor'
import { ensureNetworkAttachments } from './monitor/network-attachments'
import { clearReady, markReady } from './ready'
import { regenerateRoutes } from './routing/active-routes'
import { routesTlsFor } from './routing/traefik-config'
import { createDockerRuntime } from './runtime/docker-runtime'
import { waitHealthy } from './runtime/healthcheck'
import { fetchSource } from './source/fetch-source'

/** Compose allows 60 s to stop; what is still running after this is marked FAILED on the next start. */
const SHUTDOWN_GRACE_MS = 50_000

/** How often Traefik and the worker are reconnected to the networks of live apps (see `ensureNetworkAttachments`). */
const ATTACHMENT_CHECK_MS = 60_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  // The order matters for the ready file the compose healthcheck (and so the web dashboard) waits for; see bootWorker.
  const {
    prepared: { deps, sql, close },
  } = await bootWorker({
    clearReady: () => clearReady(),
    migrate: () => migrate(databaseUrl),
    prepare: async () => {
      const config = loadConfig()
      // A key that cannot be read ends the boot with the reason, visible in `docker compose logs worker`. Nothing
      // is sent to GitHub here: GitHub being down must not keep the worker from starting.
      const github = config.githubApp
        ? createGithubAppClient({
            appId: config.githubApp.appId,
            privateKey: await loadGithubAppKey(config.githubApp.privateKeyFile),
          })
        : undefined
      const { db, sql, close } = createDb(databaseUrl)
      const docker = createDockerRuntime()
      await ensureBuilder(runCommand, (line) => console.log(`buildx: ${line}`))
      // Without PANEL_DOMAIN the dashboard is not routed (and no hostname is reserved for it).
      const panel = config.panelDomain ? { domain: config.panelDomain, upstream: config.panelUpstream } : undefined

      const deps: PipelineDeps = {
        db,
        docker,
        config,
        run: runCommand,
        sleep: (ms) => sleep(ms),
        fetchSource,
        chooseBuilder,
        railpackPrepare,
        buildImage,
        waitHealthy,
        regenerateRoutes: () => regenerateRoutes(db, config.traefikDynamicDir, undefined, routesTlsFor(config), panel),
        cleanupImages: async (serviceInstanceId) => {
          const removed = await cleanupImages({ db, docker, config }, serviceInstanceId)
          if (removed.length > 0) console.log(`removed ${removed.length} old image(s): ${removed.join(', ')}`)
        },
        // Deployments can only ask for a token; the rest of the client is for the repository sync.
        github: github && { repositoryToken: (repo) => github.repositoryToken(repo) },
      }
      return { deps, sql, close, github }
    },
    recover: async ({ deps }) => {
      const recovered = await recoverInterruptedDeployments(deps)
      console.log(
        `recovery: ${recovered.failed} interrupted deployment(s) marked FAILED, ${recovered.removedContainers} orphaned container(s) removed`,
      )
      return recovered
    },
    markReady: () => markReady(),
  })

  const controller = new AbortController()
  startCrashMonitor(deps, controller.signal)
  // A recreated Traefik container loses its networks; this puts it back on them without a deployment.
  let checkingAttachments = false
  const attachments = setInterval(() => {
    if (checkingAttachments) return
    checkingAttachments = true
    ensureNetworkAttachments(deps)
      .catch((error: unknown) => console.error(`network attachments: ${messageOf(error)}`))
      .finally(() => {
        checkingAttachments = false
      })
  }, ATTACHMENT_CHECK_MS)
  attachments.unref()
  const listen = async (channel: string, onNotify: () => void) => (await sql.listen(channel, () => onNotify())).unlisten
  const loop = startDeployLoop({ ...deps, listen }, controller.signal)
  console.log('worker started')

  const stopRequested = new Promise<NodeJS.Signals>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  // The loop only settles early by failing (e.g. LISTEN could not be set up), which ends the worker.
  const received = await Promise.race([stopRequested, loop])
  console.log(`${received}: shutting down`)
  controller.abort()
  clearInterval(attachments)
  await clearReady().catch(() => undefined)
  const finished = await Promise.race([loop.then(() => true), sleep(SHUTDOWN_GRACE_MS, false, { ref: false })])
  if (!finished) console.error('the running deployment did not finish in time; it is marked FAILED on the next start')
  await close()
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(`worker: ${messageOf(error)}`)
  process.exit(1)
})
