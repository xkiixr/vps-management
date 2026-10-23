import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { type Db, enqueueDeployment, findPushTargets, recordWebhookDelivery, requestGithubSync } from '@vpsm/db'
import { auditBestEffort } from './audit'
import { logServerError } from './errors'

/** The largest body GitHub may send (its own limit for a payload is 25 MB). */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024

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
