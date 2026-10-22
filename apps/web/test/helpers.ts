import type { CookieJar, SessionCookieOptions } from '@/server/session'

// Stands in for Next's cookie store: what the request carried, plus every Set-Cookie the code asked for.
export class MemoryCookieJar implements CookieJar {
  readonly values = new Map<string, string>()
  readonly writes: { name: string; value: string; options: SessionCookieOptions }[] = []

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.values.set(name, value)
  }

  get(name: string): { value: string } | undefined {
    const value = this.values.get(name)
    return value === undefined ? undefined : { value }
  }

  set(name: string, value: string, options: SessionCookieOptions): void {
    this.writes.push({ name, value, options })
    this.values.set(name, value)
  }
}

// redirect() and notFound() work by throwing an error whose `digest` tells Next what to do.
export async function nextErrorDigest(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === 'string') return digest
    throw error
  }
  throw new Error('expected a redirect() or notFound() error')
}

export const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404'

export function redirectTarget(digest: string): string | undefined {
  const [code, , ...rest] = digest.split(';')
  return code === 'NEXT_REDIRECT' ? rest.slice(0, -2).join(';') : undefined
}

export const PASSWORD = 'correct horse battery staple'
