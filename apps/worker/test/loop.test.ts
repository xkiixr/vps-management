import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAppService,
  createProject,
  type Deployment,
  DEPLOYMENTS_CHANNEL,
  deployments,
  enqueueDeployment,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { startDeployLoop } from '../src/deploy/loop'
import { runDeployment } from '../src/deploy/pipeline'
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
  }
})

vi.mock('../src/deploy/pipeline', () => ({ runDeployment: vi.fn() }))

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps & { listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>> }
let instances: Record<string, string>
let controller: AbortController
let loop: Promise<void> | undefined
/** The loop's LISTEN subscriptions: channel, callback, and whether it was unlistened. */
let listeners: { channel: string; notify: () => void; unlistened: boolean }[]
/** `start <service>` / `end <service>` for every fake runDeployment, in order. */
let order: string[]
let concurrent: number
let maxConcurrent: number

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
  vi.mocked(runDeployment).mockReset()
  fakeRun(async () => new Promise((r) => setTimeout(r, 50)))
})
afterEach(async () => {
  controller.abort()
  await loop
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

/** runDeployment records start/end around `body` (keyed by service name) and tracks concurrency. */
function fakeRun(body: (service: string) => Promise<void>) {
  vi.mocked(runDeployment).mockImplementation(async (id) => {
    const service = await serviceOf(id)
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    order.push(`start ${service}`)
    try {
      await body(service)
    } finally {
      order.push(`end ${service}`)
      concurrent--
    }
  })
}

async function serviceOf(deploymentId: string): Promise<string> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId))
  return Object.entries(instances).find(([, id]) => id === row!.serviceInstanceId)![0]
}

async function get(d: { id: string }): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, d.id))
  return row!
}

const queue = (service: string) => enqueueDeployment(db, { serviceInstanceId: instances[service]!, trigger: 'manual' })

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
  expect(listeners.map((l) => l.channel)).toEqual([DEPLOYMENTS_CHANNEL])

  const d = await queue('web')
  listeners[0]!.notify()

  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(d.id, deps), { timeout: 200 })
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
  await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledWith(api!.id, deps), { timeout: 200 })
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
  expect(listeners[0]!.unlistened).toBe(true)

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

describe('when already aborted', () => {
  test('returns without listening or claiming', async () => {
    controller.abort()
    await start()
    expect(listeners).toEqual([])
    expect(claims.results).toEqual([])
  })
})
