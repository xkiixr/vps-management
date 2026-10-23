import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getGithubStatus,
  GITHUB_SYNC_CHANNEL,
  type GithubRepositoryInput,
  listGithubRepositories,
  replaceGithubRepositories,
  setGithubStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { GithubApiError, type GithubAppClient } from '../src/github/app-client'
import { startGithubSync, syncGithub } from '../src/github/sync'

// The real setGithubStatus unless a test says otherwise (mockReset in beforeEach goes back to it).
vi.mock('@vpsm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vpsm/db')>()
  return { ...actual, setGithubStatus: vi.fn(actual.setGithubStatus) }
})

const t = await setupTestDb()
const { db } = t

const NOW = new Date('2026-10-23T10:00:00.000Z')
const now = () => NOW

const repo = (id: number, fullName: string, installationId = 1): GithubRepositoryInput => ({
  id,
  fullName,
  defaultBranch: 'main',
  private: false,
  installationId,
})

const INSTALLATIONS = [
  { id: 1, account: 'acme' },
  { id: 2, account: 'bob' },
  { id: 3, account: 'empty-org' },
]
const REPOSITORIES = [repo(10, 'acme/web'), repo(11, 'acme/api'), repo(20, 'bob/blog', 2)]

type Listing = Awaited<ReturnType<GithubAppClient['listRepositories']>>

/** A client whose answers each test can replace; `app` and `listRepositories` count their calls. */
function fakeClient(listing: Listing = { installations: INSTALLATIONS, repositories: REPOSITORIES }) {
  const app = vi.fn<GithubAppClient['app']>(async () => ({ slug: 'vpsm-test' }))
  const listRepositories = vi.fn<GithubAppClient['listRepositories']>(async () => listing)
  const repositoryToken = vi.fn<GithubAppClient['repositoryToken']>(async () => null)
  const client: GithubAppClient = { app, listRepositories, repositoryToken }
  return { client, app, listRepositories, repositoryToken }
}

const names = async () => (await listGithubRepositories(db)).map((r) => r.fullName)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  vi.mocked(setGithubStatus).mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('syncGithub', () => {
  test('a sync stores the repositories and an ok status with the app slug and the count per installation', async () => {
    const { client } = fakeClient()

    const status = await syncGithub(db, client, now)

    const expected = {
      ok: true,
      checkedAt: '2026-10-23T10:00:00.000Z',
      appSlug: 'vpsm-test',
      installations: [
        { account: 'acme', repositories: 2 },
        { account: 'bob', repositories: 1 },
        { account: 'empty-org', repositories: 0 },
      ],
    }
    expect(status).toEqual(expected)
    expect(await getGithubStatus(db)).toEqual(expected)
    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
  })

  test('a sync replaces the previous list and clears an earlier error', async () => {
    await replaceGithubRepositories(db, [repo(99, 'gone/old')])
    await setGithubStatus(db, { ok: false, checkedAt: '2026-10-23T09:00:00.000Z', error: 'old failure' })

    await syncGithub(db, fakeClient().client, now)

    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
    expect(await getGithubStatus(db)).toMatchObject({ ok: true })
    expect((await getGithubStatus(db))!.error).toBeUndefined()
  })

  test('a sync with no installation stores an empty list and an ok status', async () => {
    await replaceGithubRepositories(db, [repo(99, 'gone/old')])
    const { client } = fakeClient({ installations: [], repositories: [] })

    await syncGithub(db, client, now)

    expect(await names()).toEqual([])
    expect(await getGithubStatus(db)).toEqual({
      ok: true,
      checkedAt: '2026-10-23T10:00:00.000Z',
      appSlug: 'vpsm-test',
      installations: [],
    })
  })

  test('a successful sync logs nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await syncGithub(db, fakeClient().client, now)

    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  test('the time of the check comes from the clock it is given, by default the current time', async () => {
    const before = Date.now()
    const status = await syncGithub(db, fakeClient().client)
    expect(Date.parse(status.checkedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(status.checkedAt)).toBeLessThanOrEqual(Date.now())
  })

  test('a failed sync records the error and keeps the previous list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await syncGithub(db, fakeClient().client, now)
    const failing = fakeClient()
    failing.listRepositories.mockRejectedValue(
      new GithubApiError('GitHub API GET /app/installations: 401 Bad credentials', 401),
    )

    const status = await syncGithub(db, failing.client, () => new Date('2026-10-23T10:10:00.000Z'))

    const expected = {
      ok: false,
      checkedAt: '2026-10-23T10:10:00.000Z',
      error: 'GitHub API GET /app/installations: 401 Bad credentials',
    }
    expect(status).toEqual(expected)
    expect(await getGithubStatus(db)).toEqual(expected)
    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
    expect(error).toHaveBeenCalledExactlyOnceWith('github sync: GitHub API GET /app/installations: 401 Bad credentials')
  })

  test('when the app itself cannot be read, nothing is listed or replaced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await replaceGithubRepositories(db, [repo(99, 'keep/me')])
    const failing = fakeClient()
    failing.app.mockRejectedValue(new GithubApiError('GitHub API GET /app: 401 Unauthorized', 401))

    const status = await syncGithub(db, failing.client, now)

    expect(status).toMatchObject({ ok: false, error: 'GitHub API GET /app: 401 Unauthorized' })
    expect(failing.listRepositories).not.toHaveBeenCalled()
    expect(await names()).toEqual(['keep/me'])
  })

  test('a failure that is not an Error is recorded as text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = fakeClient()
    failing.app.mockRejectedValue('boom')

    expect(await syncGithub(db, failing.client, now)).toMatchObject({ ok: false, error: 'boom' })
  })

  test('only the first line of the message is stored and logged, at most 500 characters of it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = fakeClient()
    failing.app.mockRejectedValue(new Error(`first line\nparams: acme/web,secret-value\nmore`))

    const short = await syncGithub(db, failing.client, now)
    expect(short.error).toBe('first line')
    expect(error).toHaveBeenLastCalledWith('github sync: first line')

    failing.app.mockRejectedValue(new Error(`${'x'.repeat(800)}\nsecond line`))
    const long = await syncGithub(db, failing.client, now)
    expect(long.error).toBe('x'.repeat(500))
    expect((await getGithubStatus(db))!.error).toBe('x'.repeat(500))
    expect(error).toHaveBeenLastCalledWith(`github sync: ${'x'.repeat(500)}`)
  })

  test('cutting the message never leaves half a surrogate pair, which the database would refuse', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = fakeClient()
    // The emoji is two UTF-16 units and straddles the cut at 500.
    failing.app.mockRejectedValue(new Error(`${'x'.repeat(499)}😀tail`))

    const status = await syncGithub(db, failing.client, now)

    expect(status.error).toBe('x'.repeat(499))
    expect((await getGithubStatus(db))!.error).toBe('x'.repeat(499))
  })

  test('a message with no text still leaves a reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = fakeClient()
    failing.app.mockRejectedValue(new Error(''))

    expect((await syncGithub(db, failing.client, now)).error).toBe('unknown error')
  })

  test('a list the database refuses is recorded as an error and the previous list stays', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await replaceGithubRepositories(db, [repo(99, 'keep/me')])
    // The same id twice: replaceGithubRepositories throws (and rolls back).
    const { client } = fakeClient({
      installations: [{ id: 1, account: 'acme' }],
      repositories: [repo(10, 'acme/web'), repo(10, 'acme/other')],
    })

    const status = await syncGithub(db, client, now)

    expect(status.ok).toBe(false)
    expect(status.error).toMatch(/\S/)
    expect(status.error).not.toContain('\n')
    expect(status.error!.length).toBeLessThanOrEqual(500)
    // The failing statement's parameters follow on later lines of a driver error; none may leak into the status.
    expect(status.error).not.toContain('acme/web')
    expect(await getGithubStatus(db)).toEqual(status)
    expect(await names()).toEqual(['keep/me'])
    expect(error).toHaveBeenCalledExactlyOnceWith(`github sync: ${status.error}`)
  })

  test('a status that cannot be stored is logged and the sync still returns it, without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(setGithubStatus).mockRejectedValueOnce(new Error('connection refused'))

    const status = await syncGithub(db, fakeClient().client, now)

    expect(status).toMatchObject({ ok: true, appSlug: 'vpsm-test' })
    expect(await getGithubStatus(db)).toBeNull()
    // The repositories were stored all the same.
    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
    expect(error).toHaveBeenCalledExactlyOnceWith('github sync: could not store the status: connection refused')
  })

  test('a failure and a status that cannot be stored are both logged, and still nothing is thrown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(setGithubStatus).mockRejectedValueOnce(new Error('connection refused'))
    const failing = fakeClient()
    failing.app.mockRejectedValue(new Error('GitHub API GET /app: 500'))

    const status = await syncGithub(db, failing.client, now)

    expect(status).toMatchObject({ ok: false, error: 'GitHub API GET /app: 500' })
    expect(error.mock.calls.map(([line]) => line)).toEqual([
      'github sync: GitHub API GET /app: 500',
      'github sync: could not store the status: connection refused',
    ])
  })
})

describe('startGithubSync', () => {
  let controller: AbortController
  let running: Promise<void> | undefined
  /** The sync's LISTEN subscriptions: channel, callback, and whether it was unlistened. */
  let listeners: { channel: string; notify: () => void; unlistened: boolean }[]
  let listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>>

  beforeEach(() => {
    controller = new AbortController()
    running = undefined
    listeners = []
    listen = async (channel, notify) => {
      const listener = { channel, notify, unlistened: false }
      listeners.push(listener)
      return async () => {
        listener.unlistened = true
      }
    }
  })
  afterEach(async () => {
    controller.abort()
    await running
  })

  function start(client: GithubAppClient, intervalMs?: number) {
    running = startGithubSync({ db, client, listen }, controller.signal, intervalMs)
    return running
  }

  /** Makes every listRepositories call wait for its own release; `releases[n]` lets the n-th call (0-based) finish. */
  function blocking() {
    const fake = fakeClient()
    const releases: ReturnType<typeof deferred>[] = []
    let concurrent = 0
    let maxConcurrent = 0
    fake.listRepositories.mockImplementation(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      const release = deferred()
      releases.push(release)
      try {
        await release.promise
      } finally {
        concurrent--
      }
      return { installations: INSTALLATIONS, repositories: REPOSITORIES }
    })
    return { ...fake, releases, maxConcurrent: () => maxConcurrent }
  }

  test('syncs at start, listening for the web panel on the sync channel', async () => {
    const { client, listRepositories } = fakeClient()

    start(client)

    await vi.waitFor(async () => expect((await getGithubStatus(db))?.ok).toBe(true))
    expect(listeners.map((l) => l.channel)).toEqual([GITHUB_SYNC_CHANNEL])
    expect(listRepositories).toHaveBeenCalledOnce()
    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
  })

  test('syncs again on every NOTIFY', async () => {
    const { client, listRepositories } = fakeClient()
    start(client)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(1))
    await settle()

    listeners[0]!.notify()
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2))
    await settle()
    listeners[0]!.notify()
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(3))
  })

  test('syncs every 10 minutes by default', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { client, listRepositories } = fakeClient()
    start(client)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(1))

    // vi.waitFor advances the fake clock a little too, never by minutes.
    vi.advanceTimersByTime(9 * 60_000)
    await settle()
    expect(listRepositories).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2))
    await settle()
    vi.advanceTimersByTime(10 * 60_000)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(3))
  })

  test('the interval can be chosen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { client, listRepositories } = fakeClient()
    start(client, 1000)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(1))
    await settle()

    vi.advanceTimersByTime(1000)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2))
  })

  test('it never runs two syncs at once: requests during a run lead to exactly one more run', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fake = blocking()
    start(fake.client)
    await vi.waitFor(() => expect(fake.listRepositories).toHaveBeenCalledTimes(1))

    // Three requests while the first run is blocked: two NOTIFYs and an interval tick.
    listeners[0]!.notify()
    listeners[0]!.notify()
    vi.advanceTimersByTime(10 * 60_000)
    await settle()
    expect(fake.listRepositories).toHaveBeenCalledTimes(1)

    fake.releases[0]!.resolve()
    await vi.waitFor(() => expect(fake.listRepositories).toHaveBeenCalledTimes(2))
    await settle()
    // The extra run is still blocked: nothing else has started, and nothing is queued behind it.
    expect(fake.listRepositories).toHaveBeenCalledTimes(2)
    fake.releases[1]!.resolve()
    await settle()
    expect(fake.listRepositories).toHaveBeenCalledTimes(2)
    expect(fake.maxConcurrent()).toBe(1)
    expect((await getGithubStatus(db))?.ok).toBe(true)

    // And afterwards a request starts a run again.
    listeners[0]!.notify()
    await vi.waitFor(() => expect(fake.listRepositories).toHaveBeenCalledTimes(3))
    fake.releases[2]!.resolve()
  })

  test('a request that arrives while the status is being written is not lost', async () => {
    const fake = fakeClient()
    const release = deferred()
    vi.mocked(setGithubStatus).mockImplementationOnce(async () => release.promise)
    start(fake.client)
    await vi.waitFor(() => expect(setGithubStatus).toHaveBeenCalledTimes(1))

    listeners[0]!.notify()
    release.resolve()

    await vi.waitFor(() => expect(fake.listRepositories).toHaveBeenCalledTimes(2))
  })

  test('a failing sync does not stop the next one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeClient()
    fake.app.mockRejectedValueOnce(new Error('GitHub API GET /app: 502 Bad Gateway'))
    start(fake.client)
    await vi.waitFor(async () => expect((await getGithubStatus(db))?.ok).toBe(false))
    expect(await names()).toEqual([])

    listeners[0]!.notify()

    await vi.waitFor(async () => expect((await getGithubStatus(db))?.ok).toBe(true))
    expect(await names()).toEqual(['acme/api', 'acme/web', 'bob/blog'])
  })

  test('after abort it stops listening and settles once the running sync ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fake = blocking()
    let stopped = false
    start(fake.client).then(() => (stopped = true))
    await vi.waitFor(() => expect(fake.listRepositories).toHaveBeenCalledTimes(1))
    // A request waiting behind the running sync must not start once the signal has aborted.
    listeners[0]!.notify()

    controller.abort()
    await settle()
    expect(stopped).toBe(false)
    expect(listeners.map((l) => l.unlistened)).toEqual([true])

    fake.releases[0]!.resolve()
    await running
    expect(stopped).toBe(true)
    expect((await getGithubStatus(db))?.ok).toBe(true)

    listeners[0]!.notify()
    vi.advanceTimersByTime(30 * 60_000)
    await settle()
    expect(fake.listRepositories).toHaveBeenCalledTimes(1)
  })

  test('aborting while idle settles at once', async () => {
    const { client, listRepositories } = fakeClient()
    start(client)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(1))
    await settle()

    controller.abort()

    await running
    expect(listeners.map((l) => l.unlistened)).toEqual([true])
  })

  test('a listener that cannot be released is logged and the sync still settles', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    listen = async () => async () => {
      throw new Error('connection closed')
    }
    const { client, listRepositories } = fakeClient()
    start(client)
    await vi.waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(1))

    controller.abort()

    await running
    expect(error).toHaveBeenCalledExactlyOnceWith('github sync: could not stop listening: connection closed')
  })

  test('if listening fails it rejects, without syncing', async () => {
    listen = async () => {
      throw new Error('too many connections')
    }
    const { client, listRepositories } = fakeClient()

    const started = start(client)
    running = started.catch(() => undefined) // afterEach awaits it
    await expect(started).rejects.toThrow('too many connections')

    await settle()
    expect(listRepositories).not.toHaveBeenCalled()
    expect(await getGithubStatus(db)).toBeNull()
  })

  test('when already aborted it returns without listening or syncing', async () => {
    controller.abort()
    const { client, listRepositories } = fakeClient()

    await start(client)

    expect(listeners).toEqual([])
    expect(listRepositories).not.toHaveBeenCalled()
  })
})
