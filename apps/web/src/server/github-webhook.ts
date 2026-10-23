import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { type Db, enqueueDeployment, findPushTargets, recordWebhookDelivery, requestGithubSync } from '@vpsm/db'
import { auditBestEffort } from './audit'
import { logServerError } from './errors'

/** The largest body GitHub may send (its own limit for a payload is 25 MB). */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024
/**
 * The most bytes of webhook bodies the process holds at once, all requests together. Signatures can only be checked
 * once a body is complete, so without this anybody could fill the dashboard's memory with bodies that are never signed.
 */
export const MAX_IN_FLIGHT_WEBHOOK_BYTES = 2 * MAX_WEBHOOK_BYTES
/** How long a sender has for the whole body. A connection that drips bytes must not hold its share forever. */
export const WEBHOOK_READ_DEADLINE_MS = 30_000

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/
const BRANCH_PREFIX = 'refs/heads/'
const MAX_COMMIT_MESSAGE_CHARS = 200

/**
 * True when `header` is `sha256=` and the HMAC-SHA256 of exactly these bytes under the secret. Anything that is not
 * that shape is false without comparing: `timingSafeEqual` throws on buffers of different lengths.
 */
export function verifyGithubSignature(secret: string, body: Uint8Array, header: string | null): boolean {
  const digest = header === null ? null : SIGNATURE.exec(header)?.[1]
  if (!digest) return false
  return timingSafeEqual(createHmac('sha256', secret).update(body).digest(), Buffer.from(digest, 'hex'))
}

export type WebhookInput = {
  secret: string | undefined
  event: string | null
  deliveryId: string | null
  signature: string | null
  body: Uint8Array
}
export type WebhookResult = { status: number; body: Record<string, unknown> }

const reply = (status: number, body: Record<string, unknown>): WebhookResult => ({ status, body })

// Only what a deployment needs of a push. `after` is the commit the branch now points at.
const pushSchema = z.object({
  ref: z.string(),
  after: z.string().regex(/^[0-9a-f]{40}$/),
  deleted: z.boolean().optional(),
  repository: z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
  head_commit: z.object({ message: z.string() }).nullish(),
  sender: z.object({ login: z.string() }).nullish(),
})

// Truncated by character, not by UTF-16 unit, so an emoji is never cut in half. The first slice only bounds the work.
const subject = (message: string) =>
  Array.from((message.split(/\r?\n/, 1)[0] ?? '').slice(0, MAX_COMMIT_MESSAGE_CHARS * 2))
    .slice(0, MAX_COMMIT_MESSAGE_CHARS)
    .join('')

async function queuePush(db: Db, push: z.infer<typeof pushSchema>, branch: string): Promise<WebhookResult> {
  const repo = push.repository.full_name
  const commitMessage = subject(push.head_commit?.message ?? '') || undefined
  let queued = 0
  for (const target of await findPushTargets(db, { repo, branch })) {
    let deployment
    try {
      deployment = await enqueueDeployment(db, {
        serviceInstanceId: target.instanceId,
        trigger: 'push',
        commitSha: push.after,
        commitMessage,
      })
    } catch (error) {
      // One service that cannot be queued must not keep the others from deploying.
      logServerError('queueing a push deployment', error)
      continue
    }
    queued += 1
    await auditBestEffort(db, {
      actorId: null,
      action: 'deployment.push',
      targetType: 'deployment',
      targetId: deployment.id,
      metadata: {
        project: target.projectName,
        service: target.serviceName,
        repo,
        branch,
        commitSha: push.after,
        sender: push.sender?.login ?? null,
      },
    })
  }
  return reply(202, { queued })
}

function parseJson(body: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
  } catch {
    return { ok: false }
  }
}

async function handleSigned(db: Db, event: string, payload: unknown): Promise<WebhookResult> {
  switch (event) {
    case 'ping':
      return reply(200, { ok: true })
    case 'installation':
    case 'installation_repositories':
      await requestGithubSync(db)
      return reply(202, { sync: 'requested' })
    case 'push': {
      const parsed = pushSchema.safeParse(payload)
      if (!parsed.success) return reply(400, { error: 'unexpected push payload' })
      const push = parsed.data
      if (!push.ref.startsWith(BRANCH_PREFIX)) return reply(202, { ignored: 'not a branch' })
      if (push.deleted) return reply(202, { ignored: 'branch deleted' })
      return queuePush(db, push, push.ref.slice(BRANCH_PREFIX.length))
    }
    default:
      return reply(202, { ignored: event })
  }
}

/** `202 queued: 1`: what is shown as the outcome of the last delivery. */
const outcomeOf = ({ status, body }: WebhookResult) =>
  `${status} ${Object.entries(body)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ')}`

/** A number of bytes shared by everything that reserves from it. */
export class ByteBudget {
  #used = 0
  constructor(readonly limit: number) {}

  /** The bytes reserved and not yet released. */
  get used(): number {
    return this.#used
  }

  /** Reserves `bytes` if they fit beside what is reserved already, and says whether they did. */
  tryReserve(bytes: number): boolean {
    if (this.#used + bytes > this.limit) return false
    this.#used += bytes
    return true
  }

  release(bytes: number): void {
    this.#used -= bytes
  }
}

export type WebhookBodyLimits = {
  /** The largest body accepted; a larger one is a 413. */
  maxBytes: number
  /** Shared by all requests: a body that does not fit beside the others is a 503. */
  budget: ByteBudget
  /** The time for the whole body; after it, a 408. */
  deadlineMs: number
}

/** What the route uses: one budget for the whole process. */
export const WEBHOOK_BODY_LIMITS: WebhookBodyLimits = {
  maxBytes: MAX_WEBHOOK_BYTES,
  budget: new ByteBudget(MAX_IN_FLIGHT_WEBHOOK_BYTES),
  deadlineMs: WEBHOOK_READ_DEADLINE_MS,
}

const NO_STORE = { 'Cache-Control': 'no-store' }
// Every refusal leaves the body unread, or only partly read, so the connection is closed after the answer instead of
// being kept for the next request.
const refuse = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...NO_STORE, Connection: 'close', ...headers } })
const notConfigured = () => refuse(503, 'GitHub integration is not configured')
const tooLarge = () => refuse(413, 'payload too large')
const busy = () => refuse(503, 'too many webhook deliveries in progress', { 'Retry-After': '10' })
const tooSlow = () => refuse(408, 'request timeout')

export type WebhookBody =
  /** `release` gives the body's bytes back to the budget; call it once the body is no longer needed. */
  | { ok: true; body: Uint8Array; release: () => void }
  | { ok: false; response: Response }

const DEADLINE = Symbol('deadline')

/**
 * Reads the whole body within the limits, or answers why not. A declared Content-Length is checked and reserved before
 * anything is read; a body without one is reserved chunk by chunk as it arrives. A refused stream is released, never
 * cancelled: in the server it is the incoming request itself, and cancelling it destroys the socket the answer is
 * about to be sent on. Whatever happens, what was reserved is given back unless the body is handed over.
 */
export async function readWebhookBody(request: Request, { maxBytes, budget, deadlineMs }: WebhookBodyLimits): Promise<WebhookBody> {
  const header = request.headers.get('content-length')
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null
  if (declared !== null && declared > maxBytes) return { ok: false, response: tooLarge() }

  let reserved = 0
  const release = () => {
    budget.release(reserved)
    reserved = 0
  }
  if (declared !== null) {
    if (!budget.tryReserve(declared)) return { ok: false, response: busy() }
    reserved = declared
  }

  let handedOver = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    if (request.body) {
      const reader = request.body.getReader()
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), deadlineMs)
      })
      const refuseWith = (response: Response): WebhookBody => {
        // A read still pending is rejected by this, and that rejection is already handled by the race below.
        reader.releaseLock()
        return { ok: false, response }
      }
      for (;;) {
        const next = await Promise.race([reader.read(), deadline])
        if (next === DEADLINE) return refuseWith(tooSlow())
        if (next.done) break
        size += next.value.byteLength
        if (size > maxBytes) return refuseWith(tooLarge())
        if (size > reserved) {
          if (!budget.tryReserve(size - reserved)) return refuseWith(busy())
          reserved = size
        }
        chunks.push(next.value)
      }
    }
    // The only copy: the chunks are dropped as soon as this returns.
    const body = Buffer.concat(chunks, size)
    handedOver = true
    return { ok: true, body, release }
  } finally {
    clearTimeout(timer)
    if (!handedOver) release()
  }
}

export type ReceiveOptions = {
  secret: string | undefined
  /** Asked for only once a body has been read. */
  db: () => Db
  limits?: WebhookBodyLimits
}

/**
 * One request to the webhook endpoint, as the route hands it over. Unconfigured, it is answered before anything is
 * read; otherwise the body is read within the limits and handled while its bytes stay reserved.
 */
export async function receiveGithubWebhook(request: Request, o: ReceiveOptions): Promise<Response> {
  if (!o.secret) return notConfigured()
  const read = await readWebhookBody(request, o.limits ?? WEBHOOK_BODY_LIMITS)
  if (!read.ok) return read.response
  try {
    const result = await handleGithubWebhook(o.db(), {
      secret: o.secret,
      event: request.headers.get('x-github-event'),
      deliveryId: request.headers.get('x-github-delivery'),
      signature: request.headers.get('x-hub-signature-256'),
      body: read.body,
    })
    return Response.json(result.body, { status: result.status, headers: NO_STORE })
  } finally {
    read.release()
  }
}

/**
 * Handles one delivery from GitHub. The signature over the raw bytes is the only authentication, so nothing of the
 * body is looked at until it is verified. A signed delivery is remembered as the last webhook, whatever came of it.
 */
export async function handleGithubWebhook(db: Db, i: WebhookInput): Promise<WebhookResult> {
  if (!i.secret) return reply(503, { error: 'GitHub integration is not configured' })
  if (!verifyGithubSignature(i.secret, i.body, i.signature)) return reply(401, { error: 'invalid signature' })

  const event = i.event ?? 'unknown'
  const receivedAt = new Date().toISOString()
  const json = parseJson(i.body)
  const result = json.ok ? await handleSigned(db, event, json.value) : reply(400, { error: 'invalid JSON' })

  try {
    await recordWebhookDelivery(db, { event, deliveryId: i.deliveryId, receivedAt, outcome: outcomeOf(result) })
  } catch (error) {
    logServerError('recording the last webhook delivery', error)
  }
  return result
}
