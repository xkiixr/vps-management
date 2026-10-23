import { getDb } from '@/server/db'
import { webConfig } from '@/server/config'
import { GENERIC_ERROR, logServerError } from '@/server/errors'
import { handleGithubWebhook, MAX_WEBHOOK_BYTES } from '@/server/github-webhook'

// GitHub's deliveries. No session and no Origin check: the sender is GitHub, not a browser, and the signature over
// the raw body is the whole authentication (see handleGithubWebhook). The size is limited before anything else so
// that nobody can make the server hold more than 25 MiB, configured or not. No answer is ever stored.
const headers = { 'Cache-Control': 'no-store' }
const reply = (status: number, body: unknown) => Response.json(body, { status, headers })

// The body as bytes, or null as soon as it is known to be over the limit (the rest is then not read).
async function readBody(request: Request): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function POST(request: Request): Promise<Response> {
  try {
    const tooLarge = () => reply(413, { error: 'payload too large' })
    if (Number(request.headers.get('content-length')) > MAX_WEBHOOK_BYTES) return tooLarge()
    const body = await readBody(request)
    if (!body) return tooLarge()

    const result = await handleGithubWebhook(getDb(), {
      secret: webConfig().githubWebhookSecret,
      event: request.headers.get('x-github-event'),
      deliveryId: request.headers.get('x-github-delivery'),
      signature: request.headers.get('x-hub-signature-256'),
      body,
    })
    return reply(result.status, result.body)
  } catch (error) {
    logServerError('handling a github webhook', error)
    return reply(500, { error: GENERIC_ERROR })
  }
}
