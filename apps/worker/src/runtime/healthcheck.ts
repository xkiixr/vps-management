import http from 'node:http'
import net from 'node:net'
import type { DeployConfig } from '@vpsm/core'
import type { ContainerState } from './docker-runtime'

export type HealthMode = 'http' | 'tcp' | 'running'

export type HealthTarget = { host: string; port: number; path?: string; mode: HealthMode }

export type HealthOptions = {
  timeoutMs: number
  state: () => Promise<ContainerState>
  intervalMs?: number
  runningGraceMs?: number
}

export type HealthResult = { ok: true } | { ok: false; reason: string }

const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_RUNNING_GRACE_MS = 10_000
const PROBE_TIMEOUT_MS = 5000

/** An HTTP path wins; otherwise a public domain implies the port must accept connections; otherwise we can only watch the process. */
export function healthMode(deploy: DeployConfig, hasDomain: boolean): HealthMode {
  if (deploy.healthcheckPath) return 'http'
  return hasDomain ? 'tcp' : 'running'
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  // An AggregateError (several addresses refused) has an empty message but carries the code.
  return e.message || e.code || String(err)
}

/**
 * Resolves with an error description, or `undefined` when the probe passed. Never rejects.
 * `timeoutMs` is an absolute deadline for getting the status line, on top of the socket idle timeout,
 * so a server that dribbles headers cannot keep the probe alive. The body is never read.
 */
function httpProbe(host: string, port: number, path: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let deadlineTimer: NodeJS.Timeout | undefined
    const done = (result: string | undefined) => {
      clearTimeout(deadlineTimer)
      resolve(result)
    }
    try {
      // `agent: false` = a fresh, non-keep-alive connection per probe.
      const req = http.get({ host, port, path, agent: false, timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0
        res.destroy() // only the status matters; do not wait for (or buffer) the body
        done(status >= 200 && status < 300 ? undefined : `HTTP ${status}`)
      })
      deadlineTimer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (err) => done(describeError(err)))
    } catch (err) {
      done(describeError(err))
    }
  })
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(undefined)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve('connection timed out')
    })
    socket.once('error', (err) => {
      socket.destroy()
      resolve(describeError(err))
    })
  })
}

/**
 * Waits until the container is healthy: one probe per interval, giving up after
 * `timeoutMs`. Fails immediately if the container disappears or stops running. In
 * `running` mode there is nothing to probe, so the container simply has to stay up
 * for the grace period (capped by the overall timeout) without being restarted by
 * Docker. In `http`/`tcp` mode a restart is tolerated (an app may crash once on boot)
 * but is what the timeout reason reports if the probes never succeed.
 */
export async function waitHealthy(t: HealthTarget, o: HealthOptions): Promise<HealthResult> {
  const intervalMs = o.intervalMs ?? DEFAULT_INTERVAL_MS
  const startedAt = Date.now()
  const deadline = startedAt + o.timeoutMs
  const graceEnd = startedAt + Math.min(o.runningGraceMs ?? DEFAULT_RUNNING_GRACE_MS, o.timeoutMs)
  let baselineRestarts: number | undefined
  let lastError: string | undefined

  for (let first = true; ; first = false) {
    const state = await o.state()
    if (!state.exists) return { ok: false, reason: 'container disappeared' }
    if (!state.running) return { ok: false, reason: `container exited with code ${state.exitCode}` }

    baselineRestarts ??= state.restartCount
    // Docker only reports `restarting` during the back-off wait, so a crash loop is caught by its restart count.
    const restarted = state.restartCount > baselineRestarts

    if (t.mode === 'running') {
      if (restarted) return { ok: false, reason: `container restarted during startup (exit code ${state.exitCode})` }
      // A container in restart back-off counts as running to Docker; that is not "stayed up".
      if (!state.restarting && Date.now() >= graceEnd) return { ok: true }
      if (state.restarting) lastError = 'container is restarting'
    }

    if (!first && Date.now() >= deadline) {
      const suffix = lastError === undefined ? '' : ` (last error: ${lastError})`
      return { ok: false, reason: `healthcheck timed out after ${Math.round(o.timeoutMs / 1000)}s${suffix}` }
    }

    if (t.mode !== 'running') {
      // A hung probe must not outlive the overall deadline.
      const probeTimeoutMs = Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))
      const error =
        t.mode === 'http' ? await httpProbe(t.host, t.port, t.path ?? '/', probeTimeoutMs) : await tcpProbe(t.host, t.port, probeTimeoutMs)
      if (error === undefined) return { ok: true }
      lastError = restarted ? `container restarted (exit code ${state.exitCode})` : error
    }

    const wakeAt = t.mode === 'running' && Date.now() < graceEnd ? graceEnd : deadline
    await sleep(Math.max(0, Math.min(intervalMs, wakeAt - Date.now())))
  }
}
