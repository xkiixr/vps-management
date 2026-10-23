import { generateKeyPairSync, verify } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createAppJwt, createGithubAppClient, GithubApiError, loadGithubAppKey } from '../src/github/app-client'

// Generated here: no test reads a real key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const NOW_MS = 1_700_000_000_000
const APP_ID = 5435849

type Call = { method: string; url: URL; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }
type Answer = { status?: number; statusText?: string; json?: unknown; text?: string }

/** A GitHub that answers from `handler` and records every request it receives. */
function fakeGithub(handler: (call: Call) => Answer) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const raw = init?.body
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      signal: init?.signal,
    }
    calls.push(call)
    const answer = handler(call)
    const body = answer.text ?? (answer.json === undefined ? null : JSON.stringify(answer.json))
    return new Response(body, { status: answer.status ?? 200, statusText: answer.statusText ?? '' })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function clientFor(handler: (call: Call) => Answer, extra: { timeoutMs?: number } = {}) {
  const github = fakeGithub(handler)
  const client = createGithubAppClient({ appId: APP_ID, privateKey, fetch: github.fetch, now: () => NOW_MS, ...extra })
  return { ...github, client }
}

const bearer = (call: Call) => call.headers.get('authorization')!.replace(/^Bearer /, '')
const route = (call: Call) => `${call.method} ${call.url.pathname}`

test('createAppJwt is an RS256 JWT for the app, valid 9 minutes and back-dated 60 s', () => {
  const [h, p, s] = createAppJwt(APP_ID, privateKey, 1_700_000_000).split('.')
  expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
  expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: '5435849',
  })
  expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
})

test('repositoryToken asks for a read-only token of that one repository', async () => {
  const { client, calls } = clientFor((call) =>
    route(call) === 'GET /repos/acme/web/installation' ? { json: { id: 7 } } : { status: 201, json: { token: 'ghs_x' } },
  )

  await expect(client.repositoryToken('acme/web')).resolves.toBe('ghs_x')

  expect(calls.map((c) => `${c.method} ${c.url.href}`)).toEqual([
    'GET https://api.github.com/repos/acme/web/installation',
    'POST https://api.github.com/app/installations/7/access_tokens',
  ])
  expect(calls[1]!.body).toEqual({ repositories: ['web'], permissions: { contents: 'read' } })
  for (const call of calls) {
    expect(call.headers.get('accept')).toBe('application/vnd.github+json')
    expect(call.headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(call.headers.get('user-agent')).toBe('vpsm')
    expect(call.signal).toBeInstanceOf(AbortSignal)
    // Both calls are made as the app, with a JWT that was signed with its key just now.
    const [h, p, s] = bearer(call).split('.')
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_540,
      iss: '5435849',
    })
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  }
  expect(calls[1]!.headers.get('content-type')).toBe('application/json')
})

test('repositoryToken is null when the app is not installed on the repository (404)', async () => {
  const { client, calls } = clientFor(() => ({ status: 404, statusText: 'Not Found', json: { message: 'Not Found' } }))

  await expect(client.repositoryToken('acme/web')).resolves.toBeNull()

  expect(calls.map(route)).toEqual(['GET /repos/acme/web/installation'])
})

test.each(['acme', 'acme/', '/web', 'a/b/c', '../web', 'acme/..', './.', 'acme/we b', 'acme/web?x=1', 'acme/web#'])(
  'repositoryToken refuses %j without calling GitHub',
  async (repo) => {
    const { client, calls } = clientFor(() => ({ json: {} }))

    await expect(client.repositoryToken(repo)).rejects.toThrow(`invalid repo: ${repo}`)

    expect(calls).toEqual([])
  },
)

test('a GitHub error names the call and the status, never the token or the JWT', async () => {
  const { client, calls } = clientFor((call) =>
    route(call) === 'GET /repos/acme/web/installation'
      ? { json: { id: 7 } }
      : { status: 403, statusText: 'Forbidden', json: { message: 'Resource not accessible by integration' } },
  )

  const error = await client.repositoryToken('acme/web').catch((e: unknown) => e)

  expect(error).toBeInstanceOf(GithubApiError)
  expect((error as GithubApiError).status).toBe(403)
  expect((error as GithubApiError).message).toBe(
    'GitHub API POST /app/installations/7/access_tokens: 403 Resource not accessible by integration',
  )
  expect((error as GithubApiError).message).not.toContain(bearer(calls[1]!))
})

test('the message of a failed call comes from the body when it has one, else from the status text, and is short', async () => {
  const answers: Answer[] = [
    { status: 502, statusText: 'Bad Gateway', text: '<html>nginx</html>' },
    { status: 500, statusText: 'Internal Server Error', json: { documentation_url: 'https://docs.github.com' } },
    { status: 422, statusText: 'Unprocessable Entity', json: { message: 'x'.repeat(500) } },
    { status: 401, statusText: 'Unauthorized', json: { message: '' } },
  ]
  const { client } = clientFor(() => answers.shift()!)

  await expect(client.app()).rejects.toThrow(/^GitHub API GET \/app: 502 Bad Gateway$/)
  await expect(client.app()).rejects.toThrow(/^GitHub API GET \/app: 500 Internal Server Error$/)
  await expect(client.app()).rejects.toThrow(new RegExp(`^GitHub API GET /app: 422 x{200}$`))
  await expect(client.app()).rejects.toThrow(/^GitHub API GET \/app: 401 Unauthorized$/)
})

test('a network failure is a GithubApiError without a status and without any header', async () => {
  const failing = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof globalThis.fetch
  const client = createGithubAppClient({ appId: APP_ID, privateKey, fetch: failing, now: () => NOW_MS })

  const error = await client.app().catch((e: unknown) => e)

  expect(error).toBeInstanceOf(GithubApiError)
  expect((error as GithubApiError).status).toBeNull()
  expect((error as GithubApiError).message).toBe('GitHub API GET /app: fetch failed')
})

test('an answer that is not what the call returns is a GithubApiError, not a TypeError', async () => {
  const { client } = clientFor(() => ({ text: 'not json' }))
  await expect(client.app()).rejects.toThrow(/^GitHub API GET \/app: 200 /)
  await expect(client.app()).rejects.toBeInstanceOf(GithubApiError)

  const noToken = clientFor(() => ({ json: { id: 7, token: 5 } }))
  await expect(noToken.client.repositoryToken('acme/web')).rejects.toBeInstanceOf(GithubApiError)
})

test.each(['', 'ghs_bad token', 'ghs_bad\r\nX-Injected: 1', 'ghs_bad@evil.example', 'ghs_bäd', 'ghs/../bad'])(
  'repositoryToken refuses a token of an odd shape (%j) as an unexpected answer that does not repeat it',
  async (token) => {
    const { client, calls } = clientFor((call) =>
      route(call) === 'GET /repos/acme/web/installation' ? { json: { id: 7 } } : { status: 201, json: { token } },
    )

    const error = (await client.repositoryToken('acme/web').catch((e: unknown) => e)) as GithubApiError

    expect(error).toBeInstanceOf(GithubApiError)
    expect(error.status).toBe(201)
    expect(error.message).toBe('GitHub API POST /app/installations/7/access_tokens: 201 unexpected answer')
    expect(calls).toHaveLength(2)
  },
)

test('listRepositories refuses an installation token of an odd shape before using it as a header', async () => {
  const { client, calls } = clientFor((call) => {
    switch (route(call)) {
      case 'GET /app/installations':
        return { json: [{ id: 7, account: { login: 'acme' } }] }
      case 'POST /app/installations/7/access_tokens':
        return { status: 201, json: { token: 'ghs_bad\nvalue' } }
    }
    return { status: 500, json: { message: 'unexpected call' } }
  })

  const error = (await client.listRepositories().catch((e: unknown) => e)) as GithubApiError

  expect(error).toBeInstanceOf(GithubApiError)
  expect(error.message).toBe('GitHub API POST /app/installations/7/access_tokens: 201 unexpected answer')
  expect(error.message).not.toContain('ghs_bad')
  // The token never went out in an Authorization header.
  expect(calls.map(route)).toEqual(['GET /app/installations', 'POST /app/installations/7/access_tokens'])
})

test('app() returns the slug', async () => {
  const { client, calls } = clientFor(() => ({ json: { id: APP_ID, slug: 'vpsm-team', name: 'vpsm' } }))

  await expect(client.app()).resolves.toEqual({ slug: 'vpsm-team' })

  expect(route(calls[0]!)).toBe('GET /app')
})

const repo = (id: number, fullName: string) => ({
  id,
  full_name: fullName,
  default_branch: 'main',
  private: id % 2 === 0,
  name: fullName.split('/')[1],
})

test('listRepositories follows the pages of installations and of repositories', async () => {
  const second = Array.from({ length: 150 }, (_, i) => repo(1000 + i, `bob/app-${i}`))
  const { client, calls } = clientFor((call) => {
    switch (route(call)) {
      case 'GET /app/installations':
        return { json: [{ id: 7, account: { login: 'acme' } }, { id: 8, account: { login: 'bob' } }] }
      case 'POST /app/installations/7/access_tokens':
      case 'POST /app/installations/8/access_tokens':
        return { status: 201, json: { token: `ghs_inst_${call.url.pathname.split('/')[3]}` } }
      case 'GET /installation/repositories': {
        const page = Number(call.url.searchParams.get('page'))
        if (bearer(call) === 'ghs_inst_7') {
          return { json: { total_count: 2, repositories: [repo(1, 'acme/web'), repo(2, 'acme/api')] } }
        }
        return { json: { total_count: 150, repositories: second.slice((page - 1) * 100, page * 100) } }
      }
    }
    return { status: 500, json: { message: 'unexpected call' } }
  })

  const result = await client.listRepositories()

  expect(result.installations).toEqual([
    { id: 7, account: 'acme' },
    { id: 8, account: 'bob' },
  ])
  expect(result.repositories).toHaveLength(152)
  expect(result.repositories.slice(0, 3)).toEqual([
    { id: 1, fullName: 'acme/web', defaultBranch: 'main', private: false, installationId: 7 },
    { id: 2, fullName: 'acme/api', defaultBranch: 'main', private: true, installationId: 7 },
    { id: 1000, fullName: 'bob/app-0', defaultBranch: 'main', private: true, installationId: 8 },
  ])
  expect(result.repositories.at(-1)).toMatchObject({ id: 1149, fullName: 'bob/app-149', installationId: 8 })

  expect(calls.map((c) => `${route(c)}${c.url.search}`)).toEqual([
    'GET /app/installations?per_page=100&page=1',
    'POST /app/installations/7/access_tokens',
    'GET /installation/repositories?per_page=100&page=1',
    'POST /app/installations/8/access_tokens',
    'GET /installation/repositories?per_page=100&page=1',
    'GET /installation/repositories?per_page=100&page=2',
  ])
  // The installations are listed as the app (JWT), their repositories as the installation (its token) - and the
  // token for a listing is not limited to a repository.
  expect(bearer(calls[0]!).split('.')).toHaveLength(3)
  expect(calls[1]!.body).toBeUndefined()
  expect(bearer(calls[2]!)).toBe('ghs_inst_7')
  expect(bearer(calls[5]!)).toBe('ghs_inst_8')
})

test('listRepositories asks for the next page of installations while a page is full', async () => {
  const installations = Array.from({ length: 101 }, (_, i) => ({ id: 100 + i, account: { login: `org-${i}` } }))
  const { client, calls } = clientFor((call) => {
    switch (call.method) {
      case 'POST':
        return { status: 201, json: { token: 'ghs_t' } }
      default:
        if (call.url.pathname === '/app/installations') {
          const page = Number(call.url.searchParams.get('page'))
          return { json: installations.slice((page - 1) * 100, page * 100) }
        }
        return { json: { total_count: 0, repositories: [] } }
    }
  })

  const result = await client.listRepositories()

  expect(result.installations).toHaveLength(101)
  expect(result.installations.at(-1)).toEqual({ id: 200, account: 'org-100' })
  expect(result.repositories).toEqual([])
  const listings = calls.filter((c) => c.url.pathname === '/app/installations').map((c) => c.url.search)
  expect(listings).toEqual(['?per_page=100&page=1', '?per_page=100&page=2'])
})

test('listRepositories returns a repository only once even when two installations show it', async () => {
  const { client } = clientFor((call) => {
    switch (route(call)) {
      case 'GET /app/installations':
        return { json: [{ id: 7, account: { login: 'acme' } }, { id: 8, account: { login: 'acme-two' } }] }
      case 'POST /app/installations/7/access_tokens':
        return { status: 201, json: { token: 'ghs_7' } }
      case 'POST /app/installations/8/access_tokens':
        return { status: 201, json: { token: 'ghs_8' } }
      default:
        return {
          json: { total_count: 2, repositories: [repo(1, 'acme/web'), repo(bearer(call) === 'ghs_7' ? 2 : 3, 'acme/api')] },
        }
    }
  })

  const { repositories } = await client.listRepositories()

  expect(repositories.map((r) => [r.id, r.installationId])).toEqual([
    [1, 7],
    [2, 7],
    [3, 8],
  ])
})

test('listRepositories skips a suspended installation without asking for its token', async () => {
  const { client, calls } = clientFor((call) => {
    switch (route(call)) {
      case 'GET /app/installations':
        return {
          json: [
            { id: 7, account: { login: 'acme' }, suspended_at: null },
            { id: 8, account: { login: 'gone' }, suspended_at: '2026-10-01T08:00:00Z' },
            { id: 9, account: { login: 'bob' } },
          ],
        }
      case 'POST /app/installations/7/access_tokens':
        return { status: 201, json: { token: 'ghs_7' } }
      case 'POST /app/installations/9/access_tokens':
        return { status: 201, json: { token: 'ghs_9' } }
      case 'GET /installation/repositories':
        return { json: { total_count: 1, repositories: [repo(bearer(call) === 'ghs_7' ? 1 : 2, 'x/y')] } }
    }
    return { status: 500, json: { message: 'unexpected call' } }
  })

  const result = await client.listRepositories()

  expect(result.installations).toEqual([
    { id: 7, account: 'acme' },
    { id: 9, account: 'bob' },
  ])
  expect(result.repositories.map((r) => [r.id, r.installationId])).toEqual([
    [1, 7],
    [2, 9],
  ])
  expect(calls.map(route)).not.toContain('POST /app/installations/8/access_tokens')
})

test('a failure while listing names the call without its query, the token or the JWT', async () => {
  const { client, calls } = clientFor((call) => {
    switch (route(call)) {
      case 'GET /app/installations':
        return { json: [{ id: 7, account: { login: 'acme' } }] }
      case 'POST /app/installations/7/access_tokens':
        return { status: 201, json: { token: 'ghs_listing' } }
      default:
        return { status: 500, statusText: 'Internal Server Error', json: { message: 'boom' } }
    }
  })

  const error = (await client.listRepositories().catch((e: unknown) => e)) as GithubApiError

  expect(error).toBeInstanceOf(GithubApiError)
  expect(error.message).toBe('GitHub API GET /installation/repositories: 500 boom')
  expect(error.message).not.toContain('ghs_listing')
  expect(error.message).not.toContain(bearer(calls[0]!))
})

test('a request slower than timeoutMs fails with a GithubApiError', async () => {
  const hanging = ((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
    })) as typeof globalThis.fetch
  const client = createGithubAppClient({ appId: APP_ID, privateKey, fetch: hanging, now: () => NOW_MS, timeoutMs: 50 })

  const error = await client.app().catch((e: unknown) => e)

  expect(error).toBeInstanceOf(GithubApiError)
  expect((error as GithubApiError).status).toBeNull()
  expect((error as GithubApiError).message).toBe('GitHub API GET /app: timed out after 50 ms')
})

const pem = (key: typeof privateKey) => key.export({ type: 'pkcs8', format: 'pem' }) as string

test('loadGithubAppKey reads an RSA private key (PKCS#8 and PKCS#1)', async () => {
  const pkcs8 = await loadGithubAppKey('/run/secrets/github-app.pem', async () => Buffer.from(pem(privateKey)))
  const pkcs1 = await loadGithubAppKey('/run/secrets/github-app.pem', async () =>
    Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string),
  )

  for (const key of [pkcs8, pkcs1]) {
    expect(key.type).toBe('private')
    expect(key.asymmetricKeyType).toBe('rsa')
    const [h, p, s] = createAppJwt(APP_ID, key, 1_700_000_000).split('.')
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  }
})

test('loadGithubAppKey reads the file from disk by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-app-key-'))
  try {
    const file = path.join(dir, 'app.pem')
    fs.writeFileSync(file, pem(privateKey))
    expect((await loadGithubAppKey(file)).asymmetricKeyType).toBe('rsa')
    await expect(loadGithubAppKey(path.join(dir, 'missing.pem'))).rejects.toThrow()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadGithubAppKey refuses an empty file and a file that is not a private key, without printing either', async () => {
  const file = '/run/secrets/github-app.pem'
  const load = (content: string) => loadGithubAppKey(file, async () => Buffer.from(content))
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const secret = 'SECRET-MARKER-123'

  await expect(load('')).rejects.toThrow(
    `GitHub App private key at ${file} is empty (set GITHUB_APP_PRIVATE_KEY_PATH in .env)`,
  )
  await expect(load('  \n')).rejects.toThrow(/is empty/)

  const notKeys = [
    `not a key ${secret}`,
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`,
    pem(ec.privateKey),
    publicKey.export({ type: 'spki', format: 'pem' }) as string,
  ]
  for (const content of notKeys) {
    const error = (await load(content).catch((e: unknown) => e)) as Error
    expect(error.message).toBe(`GitHub App private key at ${file} is not a valid RSA private key`)
    expect(error.message).not.toContain(secret)
    expect(error.cause).toBeUndefined()
  }
  // The EC key's own bytes do not show up either.
  const ecBody = pem(ec.privateKey).split('\n')[1]!
  const ecError = (await load(pem(ec.privateKey)).catch((e: unknown) => e)) as Error
  expect(ecError.message).not.toContain(ecBody)
})
