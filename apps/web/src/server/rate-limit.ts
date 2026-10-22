import { isIP } from 'node:net'
import type { HeaderReader } from './origin'

export type LoginLimiter = {
  /** False once `max` failures for this key fall inside the window: refuse without checking the password. */
  check(key: string): boolean
  fail(key: string): void
  reset(key: string): void
  /** Keys currently held (for tests and bounds). */
  size(): number
}

const DEFAULT_MAX_KEYS = 10_000

// In-memory and per process (the panel runs one). Each key keeps the times of its most recent failures (at most
// `max` of them); the oldest key is evicted once more than `maxKeys` keys are held, so a flood of distinct keys
// costs bounded memory. A key that fails again moves to the back of that line.
export function createLoginLimiter(o: {
  max: number
  windowMs: number
  maxKeys?: number
  now?: () => number
}): LoginLimiter {
  const maxKeys = o.maxKeys ?? DEFAULT_MAX_KEYS
  const now = o.now ?? Date.now
  const failures = new Map<string, number[]>()

  const recent = (key: string): number[] => {
    const since = now() - o.windowMs
    return (failures.get(key) ?? []).filter((at) => at > since)
  }

  return {
    check: (key) => recent(key).length < o.max,
    fail(key) {
      const times = [...recent(key), now()].slice(-o.max)
      failures.delete(key)
      failures.set(key, times)
      for (const oldest of failures.keys()) {
        if (failures.size <= maxKeys) break
        failures.delete(oldest)
      }
    },
    reset: (key) => void failures.delete(key),
    size: () => failures.size,
  }
}

// Traefik replaces any X-Forwarded-For sent by an untrusted client with the client's address, so the first
// entry is the client. Anything that is not an IP address (including a missing header) counts as "unknown",
// which also keeps limiter keys short.
export function clientIp(h: HeaderReader): string {
  const first = h.get('x-forwarded-for')?.split(',', 1)[0]?.trim() ?? ''
  return isIP(first) ? first : 'unknown'
}

// Emails are compared the way they are stored (trimmed, lowercase).
export function loginKey(ip: string, email: string): string {
  return `${ip}|${email.trim().toLowerCase()}`
}

const LIMITER_KEY = Symbol.for('vpsm.web.loginLimiter')

// 10 failed logins per IP + email in 15 minutes. Kept on globalThis so that every bundle of the server (and a dev
// server reloading modules) shares one counter.
export function loginLimiter(): LoginLimiter {
  const holder = globalThis as { [LIMITER_KEY]?: LoginLimiter }
  return (holder[LIMITER_KEY] ??= createLoginLimiter({ max: 10, windowMs: 15 * 60_000 }))
}
