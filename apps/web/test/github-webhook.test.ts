import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAppService,
  createProject,
  createUser,
  GITHUB_SYNC_CHANNEL,
  getLastWebhookDelivery,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'

const mocks = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))

import { POST } from '@/app/api/github/webhook/route'
import { handleGithubWebhook, MAX_WEBHOOK_BYTES, verifyGithubSignature } from '@/server/github-webhook'
import { PASSWORD } from './helpers'

const secret = 'test-webhook-secret-0123456789'
const encoder = new TextEncoder()
const bytes = (body: string) => encoder.encode(body)
const sign = (body: string | Uint8Array, key = secret) =>
  'sha256=' + createHmac('sha256', key).update(typeof body === 'string' ? bytes(body) : body).digest('hex')
const pushBody = (over: object = {}) =>
  JSON.stringify({
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    repository: { full_name: 'itx-insee/web' },
    head_commit: { message: 'fix login\n\nmore' },
    sender: { login: 'dev1' },
    ...over,
  })

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

let ada: SafeUser
let web: string
beforeEach(async () => {
  await t.reset()
  ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
  await createProject(t.db, 'p', ada.id)
  web = await addService('p', 'web', 'itx-insee/web', 'main')
})

// A service named `serviceName` in the (existing) project, bound to a repository and branch. Returns its instance id.
async function addService(projectName: string, serviceName: string, repo: string, branch: string): Promise<string> {
  const { instance } = await createAppService(t.db, {
    projectName,
    serviceName,
    source: { repo, branch },
    appsDomain: 'apps.example.com',
  })
  return instance.id
}

// A delivery the way GitHub sends it: the signature is over exactly the bytes handed in.
function deliver(event: string | null, body: string, over: Partial<Parameters<typeof handleGithubWebhook>[1]> = {}) {
  return handleGithubWebhook(t.db, {
    secret,
    event,
    deliveryId: 'delivery-1',
    signature: sign(body),
    body: bytes(body),
    ...over,
  })
}

const deploymentsOf = (instanceId: string) =>
  t.sql`select trigger, status, commit_sha as "commitSha", commit_message as "commitMessage", created_by_id as "createdById"
    from deployments where service_instance_id = ${instanceId} order by created_at, id`
const allDeployments = () => t.sql`select id from deployments`
const auditRows = () => t.sql`select actor_id as "actorId", action, target_type as "targetType", target_id as "targetId", metadata from audit_events order by id`

describe('verifyGithubSignature', () => {
  const body = bytes('{"zen":"Keep it logically awesome."}')

  test('accepts the HMAC-SHA256 of the exact bytes under the secret', () => {
    expect(verifyGithubSignature(secret, body, sign(body))).toBe(true)
  })

  test('rejects another secret and changed bytes', () => {
    expect(verifyGithubSignature(secret, body, sign(body, 'another-secret-0123456789'))).toBe(false)
    expect(verifyGithubSignature(secret, bytes('{"zen": "Keep it logically awesome."}'), sign(body))).toBe(false)
  })

  test.each([
    ['a missing header', null],
    ['an empty header', ''],
    ['no digest', 'sha256='],
    ['no prefix', sign(body).slice('sha256='.length)],
    ['the old sha1 scheme', 'sha1=' + 'a'.repeat(40)],
    ['a digest that is too short', sign(body).slice(0, -2)],
    ['a digest that is too long', sign(body) + '00'],
    ['64 characters that are not hex', 'sha256=' + 'z'.repeat(64)],
    ['the digest with whitespace around it', ` ${sign(body)} `],
    ['the prefix in capitals', sign(body).replace('sha256', 'SHA256')],
  ])('rejects %s without throwing', (_, header) => {
    expect(verifyGithubSignature(secret, body, header)).toBe(false)
  })

  test('compares the decoded bytes, so capital hex digits of the right digest still match', () => {
    const header = sign(body)
    expect(verifyGithubSignature(secret, body, 'sha256=' + header.slice('sha256='.length).toUpperCase())).toBe(true)
  })
})

describe('a push', () => {
  test('queues a deployment of that commit for each bound service and audits it', async () => {
    expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 1 } })
    expect(await deploymentsOf(web)).toMatchObject([
      { trigger: 'push', status: 'QUEUED', commitSha: 'a'.repeat(40), commitMessage: 'fix login', createdById: null },
    ])
    const [deployment] = await allDeployments()
    expect(await auditRows()).toEqual([
      {
        actorId: null,
        action: 'deployment.push',
        targetType: 'deployment',
        targetId: deployment!.id,
        metadata: { project: 'p', service: 'web', repo: 'itx-insee/web', branch: 'main', commitSha: 'a'.repeat(40), sender: 'dev1' },
      },
    ])
  })

  test('queues one deployment per bound service, in every project, and none for services of other repositories or branches', async () => {
    await createProject(t.db, 'q', ada.id)
    const api = await addService('q', 'api', 'itx-insee/web', 'main')
    const dev = await addService('p', 'dev', 'itx-insee/web', 'dev')
    const other = await addService('p', 'other', 'itx-insee/other', 'main')
    expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 2 } })
    expect(await deploymentsOf(web)).toHaveLength(1)
    expect(await deploymentsOf(api)).toHaveLength(1)
    expect(await deploymentsOf(dev)).toHaveLength(0)
    expect(await deploymentsOf(other)).toHaveLength(0)
    expect(await auditRows()).toHaveLength(2)
  })

  test('the repository name in another letter case and a branch with a slash still deploy; a branch in another case does not', async () => {
    const feature = await addService('p', 'feature', 'itx-insee/web', 'feature/login')
    expect(await deliver('push', pushBody({ repository: { full_name: 'ITX-Insee/Web' } }))).toEqual({ status: 202, body: { queued: 1 } })
    expect(await deliver('push', pushBody({ ref: 'refs/heads/feature/login' }))).toEqual({ status: 202, body: { queued: 1 } })
    expect(await deploymentsOf(feature)).toHaveLength(1)
    expect(await deliver('push', pushBody({ ref: 'refs/heads/Feature/login' }))).toEqual({ status: 202, body: { queued: 0 } })
    expect(await deploymentsOf(feature)).toHaveLength(1)
    expect(await auditRows()).toMatchObject([{ metadata: { repo: 'ITX-Insee/Web' } }, { metadata: { branch: 'feature/login' } }])
  })

  test('the message is the first line of the head commit, cut at 200 characters, and absent without a head commit', async () => {
    await deliver('push', pushBody({ head_commit: { message: 'x'.repeat(300) + '\nrest' } }))
    await deliver('push', pushBody({ head_commit: { message: 'windows line\r\nrest' } }))
    await deliver('push', pushBody({ head_commit: null }))
    await deliver('push', pushBody({ head_commit: undefined }))
    await deliver('push', pushBody({ head_commit: { message: '\nonly a body' } }))
    expect((await deploymentsOf(web)).map((d) => d.commitMessage)).toEqual(['x'.repeat(200), 'windows line', null, null, null])
  })

  test('the sender is null when GitHub sent none', async () => {
    await deliver('push', pushBody({ sender: undefined }))
    expect(await auditRows()).toMatchObject([{ metadata: { sender: null } }])
  })

  test('a push while one is queued skips that one; a push while one is building queues behind it', async () => {
    await deliver('push', pushBody({ after: '1'.repeat(40) }))
    await deliver('push', pushBody({ after: '2'.repeat(40) }))
    expect((await deploymentsOf(web)).map((d) => [d.commitSha?.[0], d.status])).toEqual([['1', 'SKIPPED'], ['2', 'QUEUED']])

    await t.sql`update deployments set status = 'BUILDING' where status = 'QUEUED'`
    await deliver('push', pushBody({ after: '3'.repeat(40) }))
    expect((await deploymentsOf(web)).map((d) => [d.commitSha?.[0], d.status])).toEqual([['1', 'SKIPPED'], ['2', 'BUILDING'], ['3', 'QUEUED']])
  })

  test.each([
    [{ ref: 'refs/tags/v1' }, { ignored: 'not a branch' }],
    [{ ref: 'main' }, { ignored: 'not a branch' }],
    [{ deleted: true, after: '0'.repeat(40) }, { ignored: 'branch deleted' }],
    [{ ref: 'refs/heads/dev' }, { queued: 0 }],
    [{ repository: { full_name: 'someone/else' } }, { queued: 0 }],
  ])('%j → 202 %j and nothing queued', async (over, body) => {
    expect(await deliver('push', pushBody(over))).toEqual({ status: 202, body })
    expect(await allDeployments()).toHaveLength(0)
    expect(await auditRows()).toHaveLength(0)
  })

  test('a tag that was deleted is still "not a branch", and deleted: false deploys', async () => {
    expect(await deliver('push', pushBody({ ref: 'refs/tags/v1', deleted: true }))).toEqual({ status: 202, body: { ignored: 'not a branch' } })
    expect(await deliver('push', pushBody({ deleted: false }))).toEqual({ status: 202, body: { queued: 1 } })
  })

  test('a service that cannot be queued is logged and skipped, and the others are still queued', async () => {
    const api = await addService('p', 'api', 'itx-insee/web', 'main')
    // Sorted by project and service name, `api` comes first. Inserting a deployment for it violates this constraint.
    await t.sql.unsafe(`alter table deployments add constraint poisoned check (service_instance_id <> '${api}')`)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 1 } })
    } finally {
      await t.sql`alter table deployments drop constraint poisoned`
    }
    expect(await deploymentsOf(api)).toHaveLength(0)
    expect(await deploymentsOf(web)).toHaveLength(1)
    expect(await auditRows()).toMatchObject([{ metadata: { service: 'web' } }])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('queueing a push deployment failed')
  })

  test('failing to write the audit event does not undo or hide the queued deployment', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 1 } })
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(await deploymentsOf(web)).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['not an object', 'null'],
    ['an array', '[]'],
    ['no ref', pushBody({ ref: undefined })],
    ['a ref that is not text', pushBody({ ref: 5 })],
    ['no commit', pushBody({ after: undefined })],
    ['a short commit', pushBody({ after: 'a'.repeat(39) })],
    ['a commit in capitals', pushBody({ after: 'A'.repeat(40) })],
    ['a commit that is not hex', pushBody({ after: 'g'.repeat(40) })],
    ['no repository', pushBody({ repository: undefined })],
    ['a repository without a name', pushBody({ repository: {} })],
    ['a repository name that is not owner/name', pushBody({ repository: { full_name: 'web' } })],
    ['a repository name with a path in it', pushBody({ repository: { full_name: 'a/b/c' } })],
    ['deleted that is not a boolean', pushBody({ deleted: 'yes' })],
    ['a head commit without a message', pushBody({ head_commit: {} })],
    ['a sender without a login', pushBody({ sender: {} })],
  ])('%s → 400 unexpected push payload and nothing queued', async (_, body) => {
    expect(await deliver('push', body)).toEqual({ status: 400, body: { error: 'unexpected push payload' } })
    expect(await allDeployments()).toHaveLength(0)
  })
})

describe('who may deliver', () => {
  const pushed = pushBody()

  test.each([
    ['no signature', { signature: null }],
    ['another secret', { signature: sign(pushed, 'another-secret-0123456789') }],
    ['body changed after signing', { body: bytes(pushed.replace('main', 'dev')) }],
    ['same JSON with other spacing', { body: bytes(JSON.stringify(JSON.parse(pushed), null, 1)) }],
    ['a signature that is not a digest', { signature: 'sha256=abc' }],
  ])('%s → 401 and nothing queued', async (_, over) => {
    expect(await deliver('push', pushed, over)).toEqual({ status: 401, body: { error: 'invalid signature' } })
    expect(await allDeployments()).toHaveLength(0)
    expect(await auditRows()).toHaveLength(0)
  })

  test('the signature is checked before the body is read as JSON', async () => {
    expect(await deliver('push', 'not json', { signature: sign('not json', 'another-secret-0123456789') })).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    })
  })

  test.each([undefined, ''])('without a configured secret (%j) every delivery is 503, whatever the signature', async (missing) => {
    const expected = { status: 503, body: { error: 'GitHub integration is not configured' } }
    expect(await deliver('push', pushed, { secret: missing })).toEqual(expected)
    expect(await deliver('push', pushed, { secret: missing, signature: null })).toEqual(expected)
    expect(await deliver('ping', '{}', { secret: missing, signature: sign('{}', '') })).toEqual(expected)
    expect(await allDeployments()).toHaveLength(0)
    expect(await getLastWebhookDelivery(t.db)).toBeNull()
  })
})

describe('other events', () => {
  test('ping is 200', async () => {
    expect(await deliver('ping', JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 }))).toEqual({ status: 200, body: { ok: true } })
    expect(await deliver('ping', 'null')).toEqual({ status: 200, body: { ok: true } })
  })

  test.each(['installation', 'installation_repositories'])('%s asks the worker for a sync', async (event) => {
    const heard: string[] = []
    const subscription = await t.sql.listen(GITHUB_SYNC_CHANNEL, (payload) => void heard.push(payload))
    try {
      expect(await deliver(event, JSON.stringify({ action: 'added' }))).toEqual({ status: 202, body: { sync: 'requested' } })
      await vi.waitFor(() => expect(heard).toHaveLength(1))
    } finally {
      await subscription.unlisten()
    }
  })

  test.each(['issues', 'pull_request', 'check_run'])('%s is ignored', async (event) => {
    expect(await deliver(event, '{}')).toEqual({ status: 202, body: { ignored: event } })
    expect(await allDeployments()).toHaveLength(0)
  })

  test('a delivery without an event name is ignored', async () => {
    expect(await deliver(null, '{}')).toEqual({ status: 202, body: { ignored: 'unknown' } })
  })

  test('an event is not looked at when the body is not JSON: that is a 400 first', async () => {
    for (const body of ['', 'not json', '{"a":', '\u0000']) {
      expect(await deliver('ping', body)).toEqual({ status: 400, body: { error: 'invalid JSON' } })
    }
    const notUtf8 = Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])
    expect(await deliver('push', '', { body: notUtf8, signature: sign(notUtf8) })).toEqual({ status: 400, body: { error: 'invalid JSON' } })
  })
})

describe('the last webhook', () => {
  const remembered = async () => {
    const last = await getLastWebhookDelivery(t.db)
    return last && { event: last.event, deliveryId: last.deliveryId, outcome: last.outcome }
  }

  test('every signed delivery is remembered with what came of it', async () => {
    await deliver('push', pushBody())
    expect(await remembered()).toEqual({ event: 'push', deliveryId: 'delivery-1', outcome: '202 queued: 1' })
    await deliver('push', pushBody({ ref: 'refs/tags/v1' }), { deliveryId: 'delivery-2' })
    expect(await remembered()).toEqual({ event: 'push', deliveryId: 'delivery-2', outcome: '202 ignored: not a branch' })
    await deliver('push', pushBody({ repository: {} }))
    expect(await remembered()).toMatchObject({ outcome: '400 error: unexpected push payload' })
    await deliver('ping', '{}')
    expect(await remembered()).toMatchObject({ event: 'ping', outcome: '200 ok: true' })
    await deliver('installation', '{}', { deliveryId: null })
    expect(await remembered()).toEqual({ event: 'installation', deliveryId: null, outcome: '202 sync: requested' })
    await deliver('ping', 'nope')
    expect(await remembered()).toMatchObject({ outcome: '400 error: invalid JSON' })
    await deliver('issues', '{}')
    expect(await remembered()).toMatchObject({ event: 'issues', outcome: '202 ignored: issues' })
  })

  test('the time is when the delivery was handled', async () => {
    const before = Date.now()
    await deliver('ping', '{}')
    const receivedAt = (await getLastWebhookDelivery(t.db))!.receivedAt
    expect(new Date(receivedAt).toISOString()).toBe(receivedAt)
    expect(new Date(receivedAt).getTime()).toBeGreaterThanOrEqual(before)
    expect(new Date(receivedAt).getTime()).toBeLessThanOrEqual(Date.now())
  })

  test('unsigned and unconfigured deliveries are not remembered, and do not replace the one that is', async () => {
    await deliver('ping', '{}')
    await deliver('push', pushBody(), { signature: null })
    await deliver('push', pushBody(), { signature: sign(pushBody(), 'another-secret-0123456789') })
    await deliver('push', pushBody(), { secret: undefined })
    expect(await remembered()).toEqual({ event: 'ping', deliveryId: 'delivery-1', outcome: '200 ok: true' })
  })

  test('failing to remember it is logged and does not change the answer', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table settings rename to settings_away`
    try {
      expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 1 } })
    } finally {
      await t.sql`alter table settings_away rename to settings`
    }
    expect(await deploymentsOf(web)).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('failed')
  })
})

// The route reads the settings from the environment, the way the server does.
describe('the route', () => {
  const url = 'https://panel.example.com/api/github/webhook'
  const MIB = 1024 * 1024

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://postgres:unused@localhost:5432/postgres')
    vi.stubEnv('APPS_DOMAIN', 'apps.example.com')
    vi.stubEnv('PANEL_DOMAIN', 'panel.apps.example.com')
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret)
  })

  const post = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
    POST(new Request(url, { method: 'POST', body: body as BodyInit, headers: { 'content-type': 'application/json', ...headers } }))
  const signed = (event: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
    post(body, { 'x-github-event': event, 'x-github-delivery': 'route-delivery', 'x-hub-signature-256': sign(body), ...headers })
  const json = async (response: Response) => (await response.json()) as Record<string, unknown>

  /** A request whose body is a stream of `chunks` chunks of 1 MiB; `pulled()` says how many were taken from it. */
  function streamed(chunks: number, headers: Record<string, string> = {}) {
    let pulled = 0
    const chunk = new Uint8Array(MIB)
    // highWaterMark 0: nothing is taken from the source until somebody reads, so `pulled` counts real reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= chunks) return controller.close()
          pulled += 1
          controller.enqueue(chunk)
        },
      },
      { highWaterMark: 0 },
    )
    const request = new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit)
    return { request, pulled: () => pulled }
  }

  test('the route answers POST and nothing else', async () => {
    expect(Object.keys(await import('@/app/api/github/webhook/route'))).toEqual(['POST'])
  })

  test('a signed push is a 202 that nothing may store, and queues the deployment', async () => {
    const response = await signed('push', pushBody())
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await json(response)).toEqual({ queued: 1 })
    expect(await deploymentsOf(web)).toHaveLength(1)
    expect(await getLastWebhookDelivery(t.db)).toMatchObject({ event: 'push', deliveryId: 'route-delivery', outcome: '202 queued: 1' })
  })

  test('the signature is checked over the bytes as they arrived, not over a parsed and re-serialised body', async () => {
    const odd = '{ "ref" :   "refs/heads/main",\n"after": "' + 'b'.repeat(40) + '", "repository": {"full_name": "itx-insee/web"}, "head_commit": {"message": "café 🚀"} }\n'
    expect((await signed('push', odd)).status).toBe(202)
    expect((await signed('push', odd.replace('main', 'dev'), { 'x-hub-signature-256': sign(odd) })).status).toBe(401)
    expect(await deploymentsOf(web)).toMatchObject([{ commitSha: 'b'.repeat(40), commitMessage: 'café 🚀' }])
  })

  test('a missing or wrong signature is a 401 with nothing stored', async () => {
    const unsigned = await post(pushBody(), { 'x-github-event': 'push' })
    expect(unsigned.status).toBe(401)
    expect(unsigned.headers.get('cache-control')).toBe('no-store')
    expect(await json(unsigned)).toEqual({ error: 'invalid signature' })
    expect((await signed('push', pushBody(), { 'x-hub-signature-256': sign(pushBody(), 'another-secret-0123456789') })).status).toBe(401)
    expect(await allDeployments()).toHaveLength(0)
  })

  test('without GITHUB_WEBHOOK_SECRET it is a 503', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
    const response = await signed('push', pushBody())
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await json(response)).toEqual({ error: 'GitHub integration is not configured' })
    expect(await allDeployments()).toHaveLength(0)
  })

  test('a Content-Length over 25 MiB is a 413 before the body is read, whatever the configuration', async () => {
    expect(MAX_WEBHOOK_BYTES).toBe(25 * MIB)
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
    const { request, pulled } = streamed(1, { 'content-length': String(MAX_WEBHOOK_BYTES + 1) })
    const response = await POST(request)
    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await json(response)).toEqual({ error: 'payload too large' })
    expect(pulled()).toBe(0)
  })

  test('a body that grows past 25 MiB without saying so is a 413 and the rest of it is not read', async () => {
    const { request, pulled } = streamed(40)
    const response = await POST(request)
    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await json(response)).toEqual({ error: 'payload too large' })
    expect(pulled()).toBeLessThanOrEqual(27)
  })

  test('a body of exactly 25 MiB is read: it is answered by the signature check, not by the size check', async () => {
    const body = new Uint8Array(MAX_WEBHOOK_BYTES).fill(0x20)
    const response = await signed('ping', body)
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ error: 'invalid JSON' })
    expect((await post(body, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401)
  })

  test('a Content-Length that is not a number does not decide anything: the body is measured as it is read', async () => {
    const response = await signed('ping', '{}', { 'content-length': 'abc' })
    expect(response.status).toBe(200)
  })

  test('an unexpected failure is a 500 with a generic body and a log line without the statement', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table service_instances rename to service_instances_away`
    try {
      const response = await signed('push', pushBody())
      expect(response.status).toBe(500)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await json(response)).toEqual({ error: 'something went wrong' })
    } finally {
      await t.sql`alter table service_instances_away rename to service_instances`
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain('params')
  })

  test('nothing about the secret or the signature is logged', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')].map((spy) => spy.mockImplementation(() => {}))
    await signed('push', pushBody({ repository: undefined }))
    await signed('push', pushBody(), { 'x-hub-signature-256': sign(pushBody(), 'another-secret-0123456789') })
    const printed = logs.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
    expect(printed).not.toContain(secret)
    expect(printed).not.toContain('sha256=')
  })
})
