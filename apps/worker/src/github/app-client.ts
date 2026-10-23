import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs/promises'
import type { GithubRepositoryInput } from '@vpsm/db'
import { describeDuration } from '../duration'

/**
 * A call to the GitHub API failed. `status` is the HTTP status, or null when there was no answer (network down,
 * timeout). The message names the call and what GitHub said, and never carries a token, a JWT or a header.
 */
export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'GithubApiError'
  }
}

const API_ORIGIN = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000
const PAGE_SIZE = 100
const MAX_DETAIL_LENGTH = 200
// The same shape fetch-source accepts for a clone URL.
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
// What GitHub's tokens are made of. Since 2026 an installation token is `ghs_<app id>_<JWT>`, some 520 characters
// of letters, digits, `_`, `-` and `.` (the JWT is base64url with dots between its parts), and its length varies:
// only the characters are checked. Anything else is not a token: a control character would end up in Node's
// "invalid header value" message, and the token is about to go into an Authorization header and into the userinfo
// of a clone URL, where none of these characters needs escaping.
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * The JWT with which the app itself speaks to GitHub: RS256, issued 60 s in the past (GitHub rejects a token from
 * the future, and clocks drift) and valid for 9 of the 10 minutes GitHub allows at most.
 */
export function createAppJwt(appId: number, key: KeyObject, nowSec: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) })}`
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url')}`
}

export type GithubAppClient = {
  /** The app's own slug (its page is github.com/apps/<slug>). */
  app(): Promise<{ slug: string }>
  /** A token that can read the contents of this one repository, or null when the app is not installed on it. */
  repositoryToken(repo: string): Promise<string | null>
  /** Every installation of the app and every repository it can read through them (each repository once). */
  listRepositories(): Promise<{
    installations: { id: number; account: string }[]
    repositories: GithubRepositoryInput[]
  }>
}

export type GithubAppClientOptions = {
  appId: number
  privateKey: KeyObject
  fetch?: typeof fetch
  /** The current time in milliseconds, like `Date.now`. */
  now?: () => number
  timeoutMs?: number
}

type Reply = { label: string; status: number; body: unknown }

export function createGithubAppClient(o: GithubAppClientOptions): GithubAppClient {
  const doFetch = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS
  const jwt = () => createAppJwt(o.appId, o.privateKey, Math.floor(now() / 1000))

  /**
   * One request. Anything but a 2xx (or a status listed in `accept`) throws a GithubApiError. The messages are built
   * from the method, the path without its query and what GitHub answered, never from the headers.
   */
  async function request(
    method: 'GET' | 'POST',
    target: string,
    bearer: string,
    options: { body?: unknown; accept?: number[] } = {},
  ): Promise<Reply> {
    const label = `${method} ${target.split('?')[0]}`
    const fail = (status: number | null, detail: string) => new GithubApiError(`GitHub API ${label}: ${detail}`, status)
    const signal = AbortSignal.timeout(timeoutMs)
    let response: Response
    let text: string
    try {
      response = await doFetch(`${API_ORIGIN}${target}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vpsm',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      })
      // The timeout also covers reading the body.
      text = await response.text()
    } catch (error) {
      if (signal.aborted) throw fail(null, `timed out after ${describeDuration(timeoutMs)}`)
      throw fail(null, error instanceof Error ? error.message : 'request failed')
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!response.ok && !options.accept?.includes(response.status)) {
      // What GitHub says about the failure, or - for a proxy's HTML page, say - just the status line.
      const said = (body as { message?: unknown } | null)?.message
      const detail = typeof said === 'string' && said !== '' ? said.slice(0, MAX_DETAIL_LENGTH) : response.statusText
      throw fail(response.status, `${response.status} ${detail}`)
    }
    if (response.ok && body === undefined) throw fail(response.status, `${response.status} the answer is not JSON`)
    return { label, status: response.status, body }
  }

  // A 2xx answer of another shape than expected (GitHub changed, or something sits in the way) is an error of the
  // call, not a TypeError further down.
  const unexpected = (reply: Reply) => new GithubApiError(`GitHub API ${reply.label}: ${reply.status} unexpected answer`, reply.status)
  const object = (reply: Reply): Record<string, unknown> => {
    if (typeof reply.body !== 'object' || reply.body === null || Array.isArray(reply.body)) throw unexpected(reply)
    return reply.body as Record<string, unknown>
  }
  const array = (reply: Reply): unknown[] => {
    if (!Array.isArray(reply.body)) throw unexpected(reply)
    return reply.body
  }
  const field = <T>(reply: Reply, from: unknown, name: string, type: 'string' | 'number' | 'boolean'): T => {
    const value = (from as Record<string, unknown> | null)?.[name]
    if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) throw unexpected(reply)
    return value as T
  }

  /** A token for one installation. With `repository` it can only read that repository's contents. */
  async function installationToken(installationId: number, repository?: string): Promise<string> {
    const reply = await request('POST', `/app/installations/${installationId}/access_tokens`, jwt(), {
      ...(repository === undefined ? {} : { body: { repositories: [repository], permissions: { contents: 'read' } } }),
    })
    const token = field<string>(reply, object(reply), 'token', 'string')
    // The error says what is wrong without repeating the token.
    if (!TOKEN_PATTERN.test(token)) {
      throw new GithubApiError(`GitHub API ${reply.label}: ${reply.status} the token is not in a known format`, reply.status)
    }
    return token
  }

  return {
    async app() {
      const reply = await request('GET', '/app', jwt())
      return { slug: field<string>(reply, object(reply), 'slug', 'string') }
    },

    async repositoryToken(repo) {
      // `.` and `..` match the pattern but would be resolved out of the URL path (and GitHub has no such names).
      if (!REPO_PATTERN.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error(`invalid repo: ${repo}`)
      }
      const name = repo.slice(repo.indexOf('/') + 1)
      const installation = await request('GET', `/repos/${repo}/installation`, jwt(), { accept: [404] })
      if (installation.status === 404) return null
      return installationToken(field<number>(installation, object(installation), 'id', 'number'), name)
    },

    async listRepositories() {
      const installations: { id: number; account: string }[] = []
      for (let page = 1; ; page++) {
        const reply = await request('GET', `/app/installations?per_page=${PAGE_SIZE}&page=${page}`, jwt())
        const items = array(reply)
        for (const item of items) {
          // Nothing can be read through a suspended installation, and GitHub refuses to issue a token for it: one
          // such installation must not fail the listing of the others (its repositories drop out of the list).
          const suspended = (item as { suspended_at?: unknown } | null)?.suspended_at
          if (suspended !== null && suspended !== undefined) continue
          // An installation on an enterprise has no account.
          const account = (item as { account?: { login?: unknown } | null } | null)?.account?.login
          installations.push({
            id: field<number>(reply, item, 'id', 'number'),
            account: typeof account === 'string' ? account : '',
          })
        }
        if (items.length < PAGE_SIZE) break
      }

      const repositories = new Map<number, GithubRepositoryInput>()
      for (const installation of installations) {
        const token = await installationToken(installation.id)
        let seen = 0
        for (let page = 1; ; page++) {
          const reply = await request('GET', `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, token)
          const body = object(reply)
          const items = body.repositories
          if (!Array.isArray(items)) throw unexpected(reply)
          for (const item of items) {
            const id = field<number>(reply, item, 'id', 'number')
            // A repository can be reachable through more than one installation; it is stored once.
            if (repositories.has(id)) continue
            repositories.set(id, {
              id,
              fullName: field<string>(reply, item, 'full_name', 'string'),
              defaultBranch: field<string>(reply, item, 'default_branch', 'string'),
              private: field<boolean>(reply, item, 'private', 'boolean'),
              installationId: installation.id,
            })
          }
          seen += items.length
          if (items.length === 0 || seen >= field<number>(reply, body, 'total_count', 'number')) break
        }
      }
      return { installations, repositories: [...repositories.values()] }
    },
  }
}

/**
 * Reads the app's private key. The errors name the file and what is wrong with it, never what is in it: the content
 * is the secret that signs for the whole team.
 */
export async function loadGithubAppKey(
  file: string,
  readFile: (file: string) => Promise<Buffer> = (f) => fs.readFile(f),
): Promise<KeyObject> {
  let content: Buffer
  try {
    content = await readFile(file)
  } catch (error) {
    // Node's own message names neither the setting nor, for EISDIR (Docker made a directory for a missing host
    // file), the file. No `cause`, so nothing else is carried along.
    const code = (error as { code?: unknown } | null)?.code
    throw new Error(
      `GitHub App private key at ${file} cannot be read (${typeof code === 'string' ? code : 'unknown'}); check GITHUB_APP_PRIVATE_KEY_PATH in .env`,
    )
  }
  if (content.toString('utf8').trim() === '') {
    throw new Error(`GitHub App private key at ${file} is empty (set GITHUB_APP_PRIVATE_KEY_PATH in .env)`)
  }
  const invalid = () => new Error(`GitHub App private key at ${file} is not a valid RSA private key`)
  let key: KeyObject
  try {
    key = createPrivateKey(content)
  } catch {
    // No `cause`: it could quote what the parser choked on.
    throw invalid()
  }
  // RS256 needs an RSA key; GitHub does not issue any other kind for an app.
  if (key.asymmetricKeyType !== 'rsa') throw invalid()
  return key
}
