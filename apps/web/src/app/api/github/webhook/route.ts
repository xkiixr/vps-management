import { getDb } from '@/server/db'
import { webConfig } from '@/server/config'
import { GENERIC_ERROR, logServerError } from '@/server/errors'
import { receiveGithubWebhook } from '@/server/github-webhook'

// GitHub's deliveries. No session and no Origin check: the sender is GitHub, not a browser, and the signature over
// the raw body is the whole authentication (see handleGithubWebhook). Nothing is read without a secret to check it
// against, and a body is read only within the limits of WEBHOOK_BODY_LIMITS (its size, the bytes held by all
// deliveries together, and a deadline), so nobody can make the server hold more. No answer is ever stored.
export async function POST(request: Request): Promise<Response> {
  try {
    const secret = webConfig().githubWebhookSecret
    return await receiveGithubWebhook(request, { secret, db: getDb })
  } catch (error) {
    logServerError('handling a github webhook', error)
    return Response.json({ error: GENERIC_ERROR }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
