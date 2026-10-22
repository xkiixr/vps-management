import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CLEANUP_CHANNEL,
  createAppService,
  createProject,
  createSession,
  createUser,
  type Deployment,
  DEPLOYMENTS_CHANNEL,
  deployments,
  enqueueDeployment,
  purgeExpiredSessions,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { startDeployLoop } from '../src/deploy/loop'
import { runDeployment } from '../src/deploy/pipeline'
import { sweepOrphans } from '../src/maintenance/sweep'
import { fakeDeps, type FakeDeps } from './fakes'

// What every claimNextDeployment call returned (`null` = queue empty). `failNext` makes the next call throw;
// `onEmpty` runs once, the first time the queue is found empty, before that empty result reaches the loop.
const claims = vi.hoisted(() => ({
  results: [] as (string | null)[],
  failNext: false,
  onEmpty: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('@vpsm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vpsm/db')>()
  return {
    ...actual,
    claimNextDeployment: async (...args: Parameters<typeof actual.claimNextDeployment>) => {
      if (claims.failNext) {
        claims.failNext = false
        throw new Error('connection refused')
      }
      const claimed = await actual.claimNextDeployment(...args)
      claims.results.push(claimed?.id ?? null)
      const onEmpty = claims.onEmpty
      if (!claimed && onEmpty) {
        claims.onEmpty = undefined
        await onEmpty()
      }
      return claimed
    },
    // The real purge unless a test says otherwise (mockReset in beforeEach goes back to it).
    purgeExpiredSessions: vi.fn(actual.purgeExpiredSessions),
  }
})

vi.mock('../src/deploy/pipeline', () => ({ runDeployment: vi.fn() }))
vi.mock('../src/maintenance/sweep', () => ({ sweepOrphans: vi.fn() }))

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps & { listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>> }
let instances: Record<string, string>
let controller: AbortController
let loop: Promise<void> | undefined
/** The loop's LISTEN subscriptions: channel, callback, and whether it was unlistened. */
let listeners: { channel: string; notify: () => void; unlistened: boolean }[]
/** In order: `start <service>` / `end <service>` for every fake runDeployment, `start sweep` / `end sweep` for every sweep. */
let order: string[]
let concurrent: number
let maxConcurrent: number
let clock: number

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  claims.results = []
  claims.failNext = false
  claims.onEmpty = undefined
  await createProject(db, 'shop')
  instances = {}
  for (const serviceName of ['web', 'api', 'jobs']) {
    const { instance } = await createAppService(db, {
      projectName: 'shop',
      serviceName,
      source: { repo: `acme/${serviceName}`, branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    instances[serviceName] = instance.id
  }
  listeners = []
  deps = {
    ...fakeDeps(db),
    listen: async (channel, notify) => {
      const listener = { channel, notify, unlistened: false }
      listeners.push(listener)
      return async () => {
        listener.unlistened = true
      }
    },
  }
  controller = new AbortController()
  loop = undefined
  order = []
  concurrent = 0
  maxConcurrent = 0
  clock = Date.parse('2026-10-01T00:00:00Z')
  vi.mocked(runDeployment).mockReset()
  fakeRun(async () => new Promise((r) => setTimeout(r, 50)))
  vi.mocked(sweepOrphans).mockReset()
  fakeSweep(async () => {})
  vi.mocked(purgeExpiredSessions).mockReset()
})
afterEach(async () => {
  controller.abort()
  await loop
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

/** Records `start <what>` / `end <what>` around `body` and tracks how many run at once. */
async function track<T>(what: string, body: () => Promise<T>): Promise<T> {
  concurrent++
  maxConcurrent = Math.max(maxConcurrent, concurrent)
  order.push(`start ${what}`)
  try {
    return await body()
  } finally {
    order.push(`end ${what}`)
    concurrent--
  }
}

/** runDeployment runs `body` (keyed by service name), tracked as `start <service>` / `end <service>`. */
function fakeRun(body: (service: string) => Promise<void>) {
  vi.mocked(runDeployment).mockImplementation(async (id) => {
    const service = await serviceOf(id)
    await track(service, () => body(service))
  })
}

const NOTHING_REMOVED = { containers: 0, networks: 0, images: 0 }

/** sweepOrphans runs `body`, tracked as `start sweep` / `end sweep`, and returns its result (by default: nothing removed). */
function fakeSweep(body: () => Promise<Awaited<ReturnType<typeof sweepOrphans>> | void>) {
  vi.mocked(sweepOrphans).mockImplementation(() => track('sweep', async () => (await body()) ?? NOTHING_REMOVED))
}

async function serviceOf(deploymentId: string): Promise<string> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId))
  return Object.entries(instances).find(([, id]) => id === row!.serviceInstanceId)![0]
}

async function get(d: { id: string }): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, d.id))
  return row!
}

/**
 * Enqueues a deployment of `service`. Its `created_at` (the claim order) is pinned one second after the
 * previous one's: the test database's clock can step backwards between two transactions.
 */
async function queue(service: string): Promise<Deployment> {
  const d = await enqueueDeployment(db, { serviceInstanceId: instances[service]!, trigger: 'manual' })
  clock += 1000
  await db.update(deployments).set({ createdAt: new Date(clock) }).where(eq(deployments.id, d.id))
  return d
}

function start() {
  loop = startDeployLoop(deps, controller.signal)
  return loop
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Waits until the loop has found the queue empty `n` times in all. */
const idle = (n = 1) => vi.waitFor(() => expect(claims.results.filter((r) => r === null).length).toBeGreaterThanOrEqual(n))

test('processes queued deployments one at a time in order', async () => {
  await queue('web')
  await queue('api')
  await queue('jobs')

  start()

  await vi.waitFor(() => expect(order).toHaveLength(6), { timeout: 2000 })
  expect(order).toEqual(['start web', 'end web', 'start api', 'end api', 'start jobs', 'end jobs'])
  expect(maxConcurrent).toBe(1)
  expect(vi.mocked(runDeployment).mock.calls.map(([, d]) => d)).toEqual([deps, deps, deps])
})

test('wakes up on notify', async () => {
  start()
  await idle()
  expect(listeners.map((l) => l.channel)).toEqual([DEPLOYMENTS_CHANNEL, CLEANUP_CHANNEL])

  const d = await queue('web')
  listeners[0]!.notify()

  // Resolves as soon as it ran; the bound only has to stay well below the 5 s poll.
  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps), { timeout: 2000 })
})

test('polls the queue every 5 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  start()
  await idle()

  const d = await queue('web')
  await new Promise((r) => setTimeout(r, 50))
  expect(runDeployment).not.toHaveBeenCalled()

  vi.advanceTimersByTime(5000)
  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps))
})

test('notify and poll arriving together while a deployment runs never overlap', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const release = deferred()
  fakeRun(async (service) => {
    if (service === 'web') await release.promise
  })
  await queue('web')
  start()
  await vi.waitFor(() => expect(order).toEqual(['start web']))

  await queue('api')
  for (let i = 0; i < 3; i++) {
    listeners[0]!.notify()
    vi.advanceTimersByTime(5000)
  }
  await new Promise((r) => setTimeout(r, 50))
  expect(order).toEqual(['start web'])

  release.resolve()
  await vi.waitFor(() => expect(order).toEqual(['start web', 'end web', 'start api', 'end api']))
  await idle()
  expect(maxConcurrent).toBe(1)
  expect(runDeployment).toHaveBeenCalledTimes(2)
})

test('a wake-up that arrives just as the queue is found empty is not lost', async () => {
  let api: Deployment | undefined
  claims.onEmpty = async () => {
    api = await queue('api')
    listeners[0]!.notify()
  }

  start()

  await vi.waitFor(() => expect(api).toBeDefined())
  // Long before the next 5 s poll.
  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(api!.id, deps), { timeout: 2000 })
})

test('stops claiming once aborted and lets the running deployment finish', async () => {
  const release = deferred()
  fakeRun(async (service) => {
    if (service === 'web') await release.promise
  })
  await queue('web')
  const api = await queue('api')
  const jobs = await queue('jobs')
  let stopped = false
  start().then(() => (stopped = true))
  await vi.waitFor(() => expect(order).toEqual(['start web']))

  controller.abort()
  await new Promise((r) => setTimeout(r, 50))
  expect(stopped).toBe(false)
  expect(listeners.map((l) => l.unlistened)).toEqual([true, true])

  release.resolve()
  await loop
  expect(order).toEqual(['start web', 'end web'])
  for (const d of [api, jobs]) {
    const row = await get(d)
    expect(row.status).toBe('QUEUED')
    expect(row.claimedAt).toBeNull()
  }
  listeners[0]!.notify()
  await new Promise((r) => setTimeout(r, 50))
  expect(runDeployment).toHaveBeenCalledOnce()
})

test('a failed claim is reported and the next wake-up carries on', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  claims.failNext = true
  start()
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
  expect(String(error.mock.calls[0]![0])).toContain('connection refused')

  const d = await queue('web')
  listeners[0]!.notify()
  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps))
})

describe('orphan sweep', () => {
  const deploymentsListener = () => listeners.find((l) => l.channel === DEPLOYMENTS_CHANNEL)!
  const cleanupListener = () => listeners.find((l) => l.channel === CLEANUP_CHANNEL)!
  const settle = () => new Promise((r) => setTimeout(r, 50))

  test('runs when the cleanup channel is notified', async () => {
    start()
    await idle()
    expect(sweepOrphans).not.toHaveBeenCalled()

    cleanupListener().notify()

    await vi.waitFor(() => expect(sweepOrphans).toHaveBeenCalledExactlyOnceWith(deps))
  })

  test('runs every 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    start()
    await idle()

    // vi.waitFor (in idle) advances the fake clock a little too.
    vi.advanceTimersByTime(30_000)
    await settle()
    expect(sweepOrphans).not.toHaveBeenCalled()

    vi.advanceTimersByTime(30_000)
    await vi.waitFor(() => expect(sweepOrphans).toHaveBeenCalledOnce())
  })

  test('a sweep requested while a deployment runs starts only after it, before the next deployment is claimed', async () => {
    const release = deferred()
    fakeRun(async (service) => {
      if (service === 'web') await release.promise
    })
    await queue('web')
    await queue('api')
    start()
    await vi.waitFor(() => expect(order).toEqual(['start web']))

    cleanupListener().notify()
    await settle()
    expect(sweepOrphans).not.toHaveBeenCalled()

    release.resolve()
    await vi.waitFor(() =>
      expect(order).toEqual(['start web', 'end web', 'start sweep', 'end sweep', 'start api', 'end api']),
    )
    expect(maxConcurrent).toBe(1)
  })

  test('no deployment is claimed while a sweep runs', async () => {
    const release = deferred()
    fakeSweep(() => release.promise)
    start()
    await idle()
    cleanupListener().notify()
    await vi.waitFor(() => expect(order).toEqual(['start sweep']))

    const claimed = claims.results.length
    await queue('web')
    deploymentsListener().notify()
    await settle()
    expect(claims.results).toHaveLength(claimed)
    expect(runDeployment).not.toHaveBeenCalled()

    release.resolve()
    await vi.waitFor(() => expect(order).toEqual(['start sweep', 'end sweep', 'start web', 'end web']))
    expect(maxConcurrent).toBe(1)
  })

  test('requests that arrive while busy lead to a single sweep', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const release = deferred()
    fakeRun(async () => release.promise)
    await queue('web')
    start()
    await vi.waitFor(() => expect(order).toEqual(['start web']))

    cleanupListener().notify()
    cleanupListener().notify()
    vi.advanceTimersByTime(60_000)
    release.resolve()

    await vi.waitFor(() => expect(order).toEqual(['start web', 'end web', 'start sweep', 'end sweep']))
    await idle()
    await settle()
    expect(sweepOrphans).toHaveBeenCalledOnce()
  })

  test('logs a one-line summary only when something was removed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(sweepOrphans)
      .mockResolvedValueOnce({ containers: 0, networks: 0, images: 0 })
      .mockResolvedValueOnce({ containers: 1, networks: 1, images: 2 })
    start()
    await idle()

    cleanupListener().notify()
    await vi.waitFor(() => expect(sweepOrphans).toHaveBeenCalledOnce())
    cleanupListener().notify()
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(sweepOrphans).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledExactlyOnceWith('orphan sweep: removed 1 container(s), 1 network(s), 2 image(s)')
  })

  test('a failing sweep is reported and deployments carry on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(sweepOrphans).mockRejectedValueOnce(new Error('connection refused'))
    start()
    await idle()

    cleanupListener().notify()
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(String(error.mock.calls[0]![0])).toContain('orphan sweep: connection refused')

    const d = await queue('web')
    deploymentsListener().notify()
    await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps))
  })

  test('stops sweeping once aborted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    start()
    await idle()

    controller.abort()
    await loop
    cleanupListener().notify()
    vi.advanceTimersByTime(60_000)
    await settle()

    expect(cleanupListener().unlistened).toBe(true)
    expect(sweepOrphans).not.toHaveBeenCalled()
  })

  test('if listening on the cleanup channel fails, the deployments channel is released again', async () => {
    const listen = deps.listen
    deps.listen = async (channel, notify) => {
      if (channel === CLEANUP_CHANNEL) throw new Error('too many connections')
      return listen(channel, notify)
    }

    const started = start()
    loop = started.catch(() => undefined) // afterEach awaits it
    await expect(started).rejects.toThrow('too many connections')
    expect(listeners.map((l) => [l.channel, l.unlistened])).toEqual([[DEPLOYMENTS_CHANNEL, true]])
    expect(claims.results).toEqual([])
  })
})

describe('expired dashboard sessions', () => {
  const deploymentsListener = () => listeners.find((l) => l.channel === DEPLOYMENTS_CHANNEL)!
  const cleanupListener = () => listeners.find((l) => l.channel === CLEANUP_CHANNEL)!
  const settle = () => new Promise((r) => setTimeout(r, 50))
  const sessionCount = async () => Number((await t.sql`select count(*)::int as n from sessions`)[0]!.n)

  test('are purged every 60 seconds, after the sweep; sessions that have not expired stay', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const user = await createUser(db, { email: 'ada@example.com', name: 'Ada', role: 'admin', password: 'correct horse battery staple' })
    await createSession(db, user.id)
    await createSession(db, user.id)
    await t.sql`update sessions set expires_at = now() - interval '1 second'`
    await createSession(db, user.id)
    start()
    await idle()
    expect(purgeExpiredSessions).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)

    await vi.waitFor(() => expect(purgeExpiredSessions).toHaveBeenCalledExactlyOnceWith(db))
    expect(sweepOrphans).toHaveBeenCalledOnce()
    await vi.waitFor(async () => expect(await sessionCount()).toBe(1))
  })

  test('never while a deployment runs: in the same single runner, after it and the sweep', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const release = deferred()
    fakeRun(async (service) => {
      if (service === 'web') await release.promise
    })
    vi.mocked(purgeExpiredSessions).mockImplementation(() => track('purge', async () => 0))
    await queue('web')
    await queue('api')
    start()
    await vi.waitFor(() => expect(order).toEqual(['start web']))

    vi.advanceTimersByTime(60_000)
    await settle()
    expect(purgeExpiredSessions).not.toHaveBeenCalled()

    release.resolve()
    await vi.waitFor(() =>
      expect(order).toEqual([
        'start web',
        'end web',
        'start sweep',
        'end sweep',
        'start purge',
        'end purge',
        'start api',
        'end api',
      ]),
    )
    expect(maxConcurrent).toBe(1)
  })

  test('says how many were purged only when there were some', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(purgeExpiredSessions).mockResolvedValueOnce(0).mockResolvedValueOnce(3)
    start()
    await idle()

    cleanupListener().notify()
    await vi.waitFor(() => expect(purgeExpiredSessions).toHaveBeenCalledOnce())
    await settle()
    expect(log).not.toHaveBeenCalled()

    cleanupListener().notify()
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(log).toHaveBeenCalledExactlyOnceWith('session purge: removed 3 expired dashboard session(s)')
  })

  test('a failing purge is reported, and the sweep and deployments carry on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(purgeExpiredSessions).mockRejectedValueOnce(new Error('connection refused'))
    start()
    await idle()

    cleanupListener().notify()
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(String(error.mock.calls[0]![0])).toBe('session purge: connection refused')
    expect(sweepOrphans).toHaveBeenCalledOnce()

    const d = await queue('web')
    deploymentsListener().notify()
    await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps))

    cleanupListener().notify()
    await vi.waitFor(() => expect(purgeExpiredSessions).toHaveBeenCalledTimes(2))
    expect(sweepOrphans).toHaveBeenCalledTimes(2)
  })
})

describe('when already aborted', () => {
  test('returns without listening or claiming', async () => {
    controller.abort()
    await start()
    expect(listeners).toEqual([])
    expect(claims.results).toEqual([])
  })
})
