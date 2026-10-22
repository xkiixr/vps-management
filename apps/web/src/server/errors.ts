import { notFound, unstable_rethrow } from 'next/navigation'
import { ValidationError } from '@vpsm/db'

export const GENERIC_ERROR = 'something went wrong'

// What the logic behind an action throws for a project (or anything else) the actor may not see. It is the same
// whether the thing does not exist or is somebody else's, so the 404 page it becomes reveals nothing.
export class NotFoundError extends Error {
  constructor() {
    super('not found')
    this.name = 'NotFoundError'
  }
}

const MAX_LOGGED_MESSAGE = 300

// Logs a failure without anything that could be a secret. Only the first line of the message is kept: Drizzle
// puts the statement's parameters on the following lines ("params: …"), and util.inspect would print the
// `cause` chain, so neither the error object nor its full message is logged.
export function logServerError(context: string, error: unknown): void {
  if (!(error instanceof Error)) {
    console.error(`[vpsm] ${context} failed: non-Error value thrown (${typeof error})`)
    return
  }
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code
  const firstLine = (error.message.split('\n', 1)[0] ?? '').slice(0, MAX_LOGGED_MESSAGE)
  console.error(`[vpsm] ${context} failed: ${error.name}${typeof code === 'string' ? ` (${code})` : ''}: ${firstLine}`)
}

// What a server action returns when its work throws. A ValidationError is meant for the user and is shown as it
// is; anything else is logged and becomes a generic message. redirect()/notFound() are rethrown for Next, and a
// NotFoundError becomes notFound().
export function actionError(error: unknown, context: string): { error: string } {
  unstable_rethrow(error)
  if (error instanceof NotFoundError) notFound()
  if (error instanceof ValidationError) return { error: error.message }
  logServerError(context, error)
  return { error: GENERIC_ERROR }
}
