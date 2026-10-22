import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAppService,
  createProject,
  type Deployment,
  deployments,
  enqueueDeployment,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { handleContainerDeath, isCrashFinal, startCrashMonitor } from '../src/monitor/crash-monitor'
import { reconcileLiveDeployments } from '../src/monitor/reconcile'
import { fakeDeps, type FakeDeps } from './fakes'

// The real reconcileLiveDeployments, with every run it started kept so a test can wait for it.
const reconciles = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock('../src/monitor/reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/monitor/reconcile')>()
  return {
    ...actual,
    reconcileLiveDeployments: vi.fn((...args: Parameters<typeof actual.reconcileLiveDeployments>) => {
      const run = actual.reconcileLiveDeployments(...args)
      reconciles.push(run)
      return run
    }),
  }
})

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instanceId: string
let controller: AbortController

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  const { instance } = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  instanceId = instance.id
  deps = fakeDeps(db)
  controller = new AbortController()
  reconciles.length = 0
  vi.mocked(reconcileLiveDeployments).mockClear()
})
afterEach(async () => {
  controller.abort()
  // A reconcile still running would otherwise read the next test's rows.
  await Promise.allSettled(reconciles)
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Starts the monitor and waits for the reconcile that follows its subscription. */
async function startMonitor(): Promise<void> {
  startCrashMonitor(deps, controller.signal)
  await Promise.allSettled(reconciles)
}

async function get(d: { id: string }): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, d.id))
  return row!
}

/** A live deployment whose container runs in FakeDocker under `name`. */
async function live(name: string): Promise<Deployment> {
  const d = await enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'BUILDING')
  await setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: `vpsm/${instanceId}:${d.id}` })
  await markDeploymentLive(db, { deploymentId: d.id, containerName: name })
  deps.docker.seedRunning([{ name, memoryMb: 512, deploymentId: d.id, serviceInstanceId: instanceId }])
  return get(d)
}

const crashedFinally = { running: false, restarting: false, exitCode: 1, restartCount: 10, maxRetries: 10 }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

test.each([
  [{ running: false, restarting: false, restartPolicy: 'on-failure', restartCount: 10, maxRetries: 10 }, true],
  [{ running: false, restarting: false, restartPolicy: 'on-failure', restartCount: 3, maxRetries: 10 }, false],
  [{ running: false, restarting: true, restartPolicy: 'on-failure', restartCount: 3, maxRetries: 10 }, false],
  [{ running: false, restarting: false, restartPolicy: 'no', restartCount: 0, maxRetries: 0 }, true],
  [{ running: false, restarting: false, restartPolicy: 'unless-stopped', restartCount: 50, maxRetries: 0 }, false],
  // Docker does not restart a clean exit under on-failure.
  [{ running: false, restarting: false, restartPolicy: 'on-failure', restartCount: 0, maxRetries: 10, exitCode: 0 }, true],
  [{ running: true, restarting: false, restartPolicy: 'on-failure', restartCount: 0, maxRetries: 10, exitCode: 0 }, false],
  [{ running: false, restarting: false, restartPolicy: 'unless-stopped', restartCount: 0, maxRetries: 0, exitCode: 0 }, false],
])('isCrashFinal %j', (s, expected) => expect(isCrashFinal({ exists: true, exitCode: 1, ...s })).toBe(expected))

test('isCrashFinal is false for a running container and for one that no longer exists', () => {
  const base = { exists: true, exitCode: 0, restarting: false, restartPolicy: 'no', restartCount: 0, maxRetries: 0 }
  expect(isCrashFinal({ ...base, running: true })).toBe(false)
  expect(isCrashFinal({ ...base, exists: false, running: false, restartPolicy: '' })).toBe(false)
})

describe('startCrashMonitor', () => {
  test('final crash marks live deployment CRASHED', async () => {
    const d = await live('vpsm-web-live0000')
    await startMonitor()

    deps.docker.setState('vpsm-web-live0000', crashedFinally)
    deps.docker.emitDie('vpsm-web-live0000')

    await vi.waitFor(async () => expect((await get(d)).status).toBe('CRASHED'))
    expect((await get(d)).failureReason).toBe('container exited with code 1')
    expect(deps.events).toContain('sleep 2000')
  })

  test('a clean exit under on-failure is final too', async () => {
    const d = await live('vpsm-web-live0000')
    await startMonitor()

    deps.docker.setState('vpsm-web-live0000', { running: false, restarting: false, exitCode: 0, restartCount: 0 })
    deps.docker.emitDie('vpsm-web-live0000')

    await vi.waitFor(async () => expect((await get(d)).status).toBe('CRASHED'))
    expect((await get(d)).failureReason).toBe('container exited with code 0')
  })

  test('reads the container state only after waiting 2 seconds', async () => {
    const d = await live('vpsm-web-live0000')
    const wait = deferred()
    deps.sleep = async (ms) => {
      deps.events.push(`sleep ${ms}`)
      await wait.promise
    }
    await startMonitor()

    deps.docker.setState('vpsm-web-live0000', { running: false, restarting: true })
    deps.docker.emitDie('vpsm-web-live0000')
    await vi.waitFor(() => expect(deps.events).toContain('sleep 2000'))
    // Docker gave up on it while the monitor was waiting.
    deps.docker.setState('vpsm-web-live0000', { ...crashedFinally, exitCode: 137 })
    wait.resolve()

    await vi.waitFor(async () => expect((await get(d)).status).toBe('CRASHED'))
    expect((await get(d)).failureReason).toBe('container exited with code 137')
  })

  test('resubscribes 5 seconds after the docker event stream breaks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = await live('vpsm-web-live0000')
    const wait = deferred()
    deps.sleep = async (ms) => {
      deps.events.push(`sleep ${ms}`)
      if (ms === 5000) await wait.promise
    }
    await startMonitor()
    expect(deps.docker.dieSubscribers).toBe(1)

    deps.docker.failEventStream(new Error('docker event stream closed'))
    expect(deps.docker.dieSubscribers).toBe(0)
    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('docker event stream closed')
    expect(deps.events).toEqual(['sleep 5000'])

    wait.resolve()
    await vi.waitFor(() => expect(deps.docker.dieSubscribers).toBe(1))
    await vi.waitFor(() => expect(reconciles).toHaveLength(2))
    await reconciles[1]

    deps.docker.setState('vpsm-web-live0000', crashedFinally)
    deps.docker.emitDie('vpsm-web-live0000')
    await vi.waitFor(async () => expect((await get(d)).status).toBe('CRASHED'))
  })

  test('reconciles live deployments after every (re)subscribe, catching deaths no event reported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = await live('vpsm-web-live0000')
    const wait = deferred()
    deps.sleep = async (ms) => {
      if (ms === 5000) await wait.promise
    }
    await startMonitor()
    expect(reconcileLiveDeployments).toHaveBeenCalledExactlyOnceWith(deps, { startStopped: false })
    expect((await get(d)).status).toBe('SUCCESS')

    deps.docker.failEventStream(new Error('boom'))
    // Dies while the monitor is not subscribed: its die event reaches nobody.
    deps.docker.setState('vpsm-web-live0000', crashedFinally)
    deps.docker.emitDie('vpsm-web-live0000')
    wait.resolve()

    await vi.waitFor(() => expect(reconciles).toHaveLength(2))
    await reconciles[1]
    expect(reconcileLiveDeployments).toHaveBeenLastCalledWith(deps, { startStopped: false })
    expect((await get(d)).status).toBe('CRASHED')
    expect((await get(d)).failureReason).toBe('container exited with code 1')
  })

  test('a failed reconcile is reported and the monitor keeps watching', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = await live('vpsm-web-live0000')
    vi.spyOn(deps.docker, 'state').mockRejectedValueOnce(new Error('daemon down'))

    await startMonitor()

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('daemon down')
    deps.docker.setState('vpsm-web-live0000', crashedFinally)
    deps.docker.emitDie('vpsm-web-live0000')
    await vi.waitFor(async () => expect((await get(d)).status).toBe('CRASHED'))
  })

  test('does not resubscribe once stopped during the 5 second wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wait = deferred()
    deps.sleep = async () => wait.promise
    startCrashMonitor(deps, controller.signal)

    deps.docker.failEventStream(new Error('boom'))
    controller.abort()
    wait.resolve()
    await wait.promise
    await new Promise((r) => setImmediate(r))

    expect(deps.docker.dieSubscribers).toBe(0)
  })

  test('unsubscribes when stopped', () => {
    startCrashMonitor(deps, controller.signal)
    expect(deps.docker.dieSubscribers).toBe(1)
    controller.abort()
    expect(deps.docker.dieSubscribers).toBe(0)
  })

  test('does nothing when already stopped', () => {
    controller.abort()
    startCrashMonitor(deps, controller.signal)
    expect(deps.docker.dieSubscribers).toBe(0)
    expect(reconcileLiveDeployments).not.toHaveBeenCalled()
  })
})

describe('handleContainerDeath', () => {
  test('leaves a deployment alone while Docker is still restarting its container', async () => {
    const d = await live('vpsm-web-live0000')
    deps.docker.setState('vpsm-web-live0000', { running: false, restarting: true, exitCode: 1, restartCount: 3 })

    await handleContainerDeath(deps, 'vpsm-web-live0000', controller.signal)

    expect((await get(d)).status).toBe('SUCCESS')
  })

  test('leaves a deployment alone when its container is already gone', async () => {
    const d = await live('vpsm-web-live0000')
    await deps.docker.stopAndRemove('vpsm-web-live0000', 0)

    await handleContainerDeath(deps, 'vpsm-web-live0000', controller.signal)

    expect((await get(d)).status).toBe('SUCCESS')
  })

  test('does not mark a replaced (REMOVED) deployment CRASHED when its container is stopped', async () => {
    const old = await live('vpsm-web-old00000')
    await setDeploymentStatus(db, old.id, 'REMOVED')
    deps.docker.setState('vpsm-web-old00000', { running: false, restarting: false, restartPolicy: 'no', exitCode: 0 })

    await handleContainerDeath(deps, 'vpsm-web-old00000', controller.signal)

    expect((await get(old)).status).toBe('REMOVED')
  })

  test('ignores a container whose deployment is unknown', async () => {
    deps.docker.seedRunning([{ name: 'vpsm-web-stray000', memoryMb: 512, deploymentId: '' }])
    deps.docker.setState('vpsm-web-stray000', crashedFinally)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handleContainerDeath(deps, 'vpsm-web-stray000', controller.signal)

    expect(error).not.toHaveBeenCalled()
  })

  test('skips the check when the worker is shutting down', async () => {
    const d = await live('vpsm-web-live0000')
    deps.docker.setState('vpsm-web-live0000', crashedFinally)
    controller.abort()

    await handleContainerDeath(deps, 'vpsm-web-live0000', controller.signal)

    expect((await get(d)).status).toBe('SUCCESS')
  })

  test('reports a failed check on stderr instead of throwing', async () => {
    await live('vpsm-web-live0000')
    vi.spyOn(deps.docker, 'state').mockRejectedValue(new Error('daemon down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(handleContainerDeath(deps, 'vpsm-web-live0000', controller.signal)).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('daemon down')
  })
})
