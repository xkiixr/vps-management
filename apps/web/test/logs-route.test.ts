import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appendDeploymentLogs,
  createAppService,
  createProject,
  createSession,
  createUser,
  enqueueDeployment,
  markLogsClosed,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'

// Next's request scope is replaced by a cookie store holding the session token the test chose (and recording every
// cookie the code tried to set). The session lookup, the access rules and the log queries are the real code.
const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  token: undefined as string | undefined,
  cookieWrites: [] as unknown[][],
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === '__Host-vpsm_session' && mocks.token !== undefined ? { value: mocks.token } : undefined),
    set: (...args: unknown[]) => void mocks.cookieWrites.push(args),
  }),
}))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))

import { GET } from '@/app/api/deployments/[id]/logs/route'
import { LOG_PAGE_SIZE } from '@/lib/logs'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})

let ada: SafeUser
let bob: SafeUser
let root: SafeUser
beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  ada = await make('ada@example.com', 'Ada', 'member')
  bob = await make('bob@example.com', 'Bob', 'member')
  root = await make('root@example.com', 'Root', 'admin')
  await signInAs(ada)
  mocks.cookieWrites.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function signInAs(user: SafeUser | null) {
  mocks.token = user ? (await createSession(t.db, user.id)).token : undefined
}

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

// Ada's `shop/web` with one deployment with `count` log lines, in `status`, and with its log closed if `closed`.
async function shopDeployment(count = 0, status = 'BUILDING', closed = false) {
  await createProject(t.db, 'shop', ada.id)
  const { instance } = await createAppService(t.db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  const deployment = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'manual', createdById: ada.id })
  await setStatus(deployment.id, status)
  if (count > 0) await appendDeploymentLogs(t.db, deployment.id, 'build', Array.from({ length: count }, (_, i) => `line ${i + 1}`))
  if (closed) await markLogsClosed(t.db, deployment.id)
  return { deployment, instance }
}
// The status is set directly: these tests are about what the route says of a status, not about the transitions.
const setStatus = (id: string, status: string) => t.sql`update deployments set status = ${status} where id = ${id}`

const call = (id: string, query = '') =>
  GET(new Request(`https://panel.example.com/api/deployments/${id}/logs${query}`), { params: Promise.resolve({ id }) })
const json = async (response: Response) => (await response.json()) as Record<string, unknown>

test('the route answers GET and nothing else', async () => {
  expect(Object.keys(await import('@/app/api/deployments/[id]/logs/route'))).toEqual(['GET'])
})

describe('who may read', () => {
  test('without a session cookie it is a 401 with a JSON body, not a redirect, and no cookie is set', async () => {
    const { deployment } = await shopDeployment(2)
    mocks.token = undefined
    const response = await call(deployment.id)
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await json(response)).toEqual({ error: 'unauthorized' })
    expect(mocks.cookieWrites).toEqual([])
  })

  test('an unknown, expired or disabled-user session is the same 401', async () => {
    const { deployment } = await shopDeployment(2)
    mocks.token = 'a'.repeat(43)
    expect((await call(deployment.id)).status).toBe(401)

    await signInAs(ada)
    await t.sql`update sessions set expires_at = now() - interval '1 minute'`
    expect((await call(deployment.id)).status).toBe(401)

    await signInAs(ada)
    await t.sql`update users set disabled_at = now() where id = ${ada.id}`
    expect((await call(deployment.id)).status).toBe(401)
  })

  test('someone who is not a member gets the same 404 as for a deployment that does not exist', async () => {
    const { deployment } = await shopDeployment(3)
    await signInAs(bob)
    const outsider = await call(deployment.id, '?after=0')
    const missing = await call(UNKNOWN_ID, '?after=0')
    const malformed = await call('not-a-uuid', '?after=0')
    for (const response of [outsider, missing, malformed]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const bodies = await Promise.all([outsider, missing, malformed].map(json))
    expect(bodies[0]).toEqual({ error: 'not found' })
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
  })

  test('an outsider gets the 404 whatever else is wrong with the request', async () => {
    const { deployment } = await shopDeployment(3)
    await signInAs(bob)
    expect((await call(deployment.id, '?after=-1')).status).toBe(404)
    expect((await call(deployment.id, '?after=abc')).status).toBe(404)
  })

  test('a member of the project and an admin who is not a member may read', async () => {
    const { deployment } = await shopDeployment(2)
    for (const user of [ada, root]) {
      await signInAs(user)
      const response = await call(deployment.id)
      expect(response.status).toBe(200)
      expect((await json(response)).lines).toHaveLength(2)
    }
  })

  test('a member who was removed from the project no longer may', async () => {
    const { deployment } = await shopDeployment(2)
    await t.sql`delete from project_members where user_id = ${ada.id}`
    expect((await call(deployment.id)).status).toBe(404)
  })
})

describe('what it returns', () => {
  test('the lines in order with their phase, the id of the last one, and no store of the answer', async () => {
    const { deployment } = await shopDeployment()
    await appendDeploymentLogs(t.db, deployment.id, 'build', ['cloning', 'npm ci'])
    await appendDeploymentLogs(t.db, deployment.id, 'deploy', ['starting'])
    const response = await call(deployment.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')

    const body = await json(response)
    const lines = body.lines as { id: number; phase: string; line: string }[]
    expect(lines.map(({ phase, line }) => [phase, line])).toEqual([
      ['build', 'cloning'],
      ['build', 'npm ci'],
      ['deploy', 'starting'],
    ])
    expect(Object.keys(lines[0]!).sort()).toEqual(['id', 'line', 'phase'])
    expect(lines.map((line) => line.id)).toEqual([...lines.map((line) => line.id)].sort((a, b) => a - b))
    expect(body).toEqual({ lines, lastId: lines[2]!.id, finished: false })
    expect(Object.keys(body).sort()).toEqual(['finished', 'lastId', 'lines'])
  })

  test('without `after` it starts at the beginning, and `after` skips what the caller already has', async () => {
    const { deployment } = await shopDeployment(5)
    const all = (await json(await call(deployment.id))).lines as { id: number; line: string }[]
    expect(all.map((l) => l.line)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
    expect((await json(await call(deployment.id, '?after=0'))).lines).toEqual(all)

    const rest = await json(await call(deployment.id, `?after=${all[2]!.id}`))
    expect((rest.lines as { line: string }[]).map((l) => l.line)).toEqual(['line 4', 'line 5'])
    expect(rest.lastId).toBe(all[4]!.id)
  })

  test('with nothing new it returns no lines and the same position, so the caller keeps its place', async () => {
    const { deployment } = await shopDeployment(3)
    const lastId = ((await json(await call(deployment.id))).lastId as number)
    expect(await json(await call(deployment.id, `?after=${lastId}`))).toEqual({ lines: [], lastId, finished: false })
    expect(await json(await call(deployment.id, `?after=${lastId + 1000}`))).toEqual({ lines: [], lastId: lastId + 1000, finished: false })
  })

  test('a deployment without any line gives an empty page at position 0', async () => {
    const { deployment } = await shopDeployment()
    expect(await json(await call(deployment.id))).toEqual({ lines: [], lastId: 0, finished: false })
  })

  test('only the lines of that deployment, never those of another one', async () => {
    const { deployment, instance } = await shopDeployment(2)
    const other = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'manual' })
    await appendDeploymentLogs(t.db, other.id, 'build', ['secret of another deployment'])
    const lines = (await json(await call(deployment.id))).lines as { line: string }[]
    expect(lines.map((l) => l.line)).toEqual(['line 1', 'line 2'])
  })

  test('text is returned as text: markup and control characters are not interpreted or changed', async () => {
    const { deployment } = await shopDeployment()
    const awkward = ['<script>alert(1)</script>', '  indented\t  with   spaces', '\u001b[31mred\u001b[0m', '</pre><img src=x onerror=1>', '']
    await appendDeploymentLogs(t.db, deployment.id, 'build', awkward)
    const response = await call(deployment.id)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(((await json(response)).lines as { line: string }[]).map((l) => l.line)).toEqual(awkward)
  })

  test('at most one page of lines is returned and the caller continues from lastId', async () => {
    const { deployment } = await shopDeployment(LOG_PAGE_SIZE + 3)
    const first = await json(await call(deployment.id))
    expect(first.lines).toHaveLength(LOG_PAGE_SIZE)
    const second = await json(await call(deployment.id, `?after=${first.lastId}`))
    expect((second.lines as { line: string }[]).map((l) => l.line)).toEqual([
      `line ${LOG_PAGE_SIZE + 1}`,
      `line ${LOG_PAGE_SIZE + 2}`,
      `line ${LOG_PAGE_SIZE + 3}`,
    ])
  })
})

describe('after', () => {
  test.each(['-1', '1.5', 'abc', '', ' 1', '1 ', '+1', '1e3', '0x10', '１２', '99999999999999999999', 'NaN', 'Infinity', '1;2'])(
    '%j is a 400, not an empty page and not an error from the database',
    async (after) => {
      const { deployment } = await shopDeployment(3)
      const response = await call(deployment.id, `?after=${encodeURIComponent(after)}`)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await json(response)).toEqual({ error: 'after must be a whole number, 0 or more' })
    },
  )

  test('0 and a big whole number are fine', async () => {
    const { deployment } = await shopDeployment(2)
    expect((await call(deployment.id, '?after=0')).status).toBe(200)
    expect((await call(deployment.id, `?after=${Number.MAX_SAFE_INTEGER}`)).status).toBe(200)
  })
})

// The worker sets the final status first, then writes the last lines (going live, the failure line), and only then
// closes the log. Only a closed log is finished: the status alone says nothing about the tail.
describe('finished', () => {
  test.each(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'])('is true when the status is %s and the log is closed', async (status) => {
    const { deployment } = await shopDeployment(2, status, true)
    expect(await json(await call(deployment.id))).toMatchObject({ finished: true })
  })

  test.each(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'])('is false when the status is %s but the log is still open', async (status) => {
    const { deployment } = await shopDeployment(2, status, false)
    expect(await json(await call(deployment.id))).toMatchObject({ finished: false })
  })

  test('is true for SKIPPED, which never ran and has no log to close', async () => {
    const { deployment } = await shopDeployment(0, 'SKIPPED', false)
    expect(await json(await call(deployment.id))).toEqual({ lines: [], lastId: 0, finished: true })
  })

  test.each(['QUEUED', 'BUILDING', 'DEPLOYING'])('is false when the status is %s, also if a log was closed', async (status) => {
    const { deployment } = await shopDeployment(2, status, true)
    expect(await json(await call(deployment.id))).toMatchObject({ finished: false })
  })

  test('with the order of the worker (final status, more lines, then the log closed) it is not finished until the end, and nothing is lost', async () => {
    const { deployment } = await shopDeployment(2, 'BUILDING')
    const first = await json(await call(deployment.id))
    expect(first).toMatchObject({ finished: false })

    // SUCCESS is set before the lines about going live and about the old container.
    await setStatus(deployment.id, 'SUCCESS')
    await appendDeploymentLogs(t.db, deployment.id, 'deploy', ['==> Live at https://web-shop.apps.example.com'])
    const second = await json(await call(deployment.id, `?after=${first.lastId}`))
    expect(second).toMatchObject({ lines: [{ line: '==> Live at https://web-shop.apps.example.com' }], finished: false })

    await appendDeploymentLogs(t.db, deployment.id, 'deploy', ['==> Stopping previous container vpsm-web-old'])
    const third = await json(await call(deployment.id, `?after=${second.lastId}`))
    expect(third).toMatchObject({ lines: [{ line: '==> Stopping previous container vpsm-web-old' }], finished: false })

    await markLogsClosed(t.db, deployment.id)
    const last = await json(await call(deployment.id, `?after=${third.lastId}`))
    expect(last).toEqual({ lines: [], lastId: third.lastId, finished: true })
    const all = await json(await call(deployment.id))
    expect((all.lines as { line: string }[]).map((l) => l.line)).toEqual([
      'line 1',
      'line 2',
      '==> Live at https://web-shop.apps.example.com',
      '==> Stopping previous container vpsm-web-old',
    ])
  })

  test('the same on failure: FAILED, then the failure line, then closed', async () => {
    const { deployment } = await shopDeployment(1, 'DEPLOYING')
    await setStatus(deployment.id, 'FAILED')
    const before = await json(await call(deployment.id))
    expect(before.finished).toBe(false)
    await appendDeploymentLogs(t.db, deployment.id, 'deploy', ['==> Deployment failed: healthcheck timed out'])
    await markLogsClosed(t.db, deployment.id)
    const after = await json(await call(deployment.id, `?after=${before.lastId}`))
    expect(after).toMatchObject({ lines: [{ line: '==> Deployment failed: healthcheck timed out' }], finished: true })
  })

  test('is false while lines of a finished deployment are still to come, and true with the last page', async () => {
    const { deployment } = await shopDeployment(LOG_PAGE_SIZE + 1, 'FAILED', true)
    const first = await json(await call(deployment.id))
    expect(first).toMatchObject({ finished: false })
    expect(await json(await call(deployment.id, `?after=${first.lastId}`))).toMatchObject({ finished: true })
  })
})

describe('no side effects', () => {
  test('it sets no cookie, even when the session is due for renewal, and records no audit event', async () => {
    const { deployment } = await shopDeployment(2)
    await t.sql`update sessions set expires_at = now() + interval '1 day'`
    const response = await call(deployment.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(mocks.cookieWrites).toEqual([])
    expect(await t.sql`select 1 from audit_events`).toHaveLength(0)
  })

  test('it does not look at the Origin header: it is a read', async () => {
    const { deployment } = await shopDeployment(1)
    const response = await GET(
      new Request(`https://panel.example.com/api/deployments/${deployment.id}/logs`, { headers: { origin: 'https://evil.example.com' } }),
      { params: Promise.resolve({ id: deployment.id }) },
    )
    expect(response.status).toBe(200)
  })

  test('an unexpected failure is a 500 with a generic JSON body and a log line without the statement', async () => {
    const { deployment } = await shopDeployment(1)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table deployment_logs rename to deployment_logs_away`
    try {
      const response = await call(deployment.id)
      expect(response.status).toBe(500)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await json(response)).toEqual({ error: 'something went wrong' })
    } finally {
      await t.sql`alter table deployment_logs_away rename to deployment_logs`
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain('params')
  })
})
