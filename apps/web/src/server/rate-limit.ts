import { isIP } from 'node:net'
import type { HeaderReader } from './origin'

export type LoginLimiter = {
  /**
   * False once `max` failures for this key fall inside the window: refuse without checking the password. Also false
   * for a key the limiter has no room for (see createLoginLimiter).
   */
  check(key: string): boolean
  /** Records a failure. A key the limiter has no room for is not recorded (check() has already refused it). */
  fail(key: string): void
  reset(key: string): void
  /** Keys currently held (for tests and bounds). */
  size(): number
}

const DEFAULT_MAX_KEYS = 10_000

// The per-email limiter (key: IP + email) holds more. One address can make up to 50 of its keys per window before
// the per-IP limiter stops it, and a full limiter refuses every new key, i.e. every sign-in by someone who has not
// failed lately: at 10 000 keys 200 addresses could lock everyone out, at 100 000 it takes 2 000. Measured cost
// when full: about 60 MiB with the longest keys login() lets through (IPv6 address and a 320-character email).
const PER_EMAIL_MAX_KEYS = 100_000

// In-memory and per process (the panel runs one). Each key keeps the times of its most recent failures (at most
// `max`). At most `maxKeys` keys are held, so a flood of distinct keys costs bounded memory. A key whose failures
// have all left the window is dropped to make room; a key with a failure still inside the window never is, or
// junk keys could push a blocked key out and unblock it. When every held key is live, new keys are refused
// (check() is false), which is the safe side: the attempt is not made.
export function createLoginLimiter(o: {
  max: number
  windowMs: number
  maxKeys?: number
  now?: () => number
}): LoginLimiter {
  const maxKeys = o.maxKeys ?? DEFAULT_MAX_KEYS
  const now = o.now ?? Date.now
  // fail() re-inserts its key at the end, so the map is ordered by each key's latest failure and the expired keys
  // are all at the front.
  const failures = new Map<string, number[]>()

  const recent = (key: string): number[] => {
    const since = now() - o.windowMs
    return (failures.get(key) ?? []).filter((at) => at > since)
  }

  const pruneExpired = () => {
    const since = now() - o.windowMs
    for (const [key, times] of failures) {
      if (times.at(-1)! > since) break
      failures.delete(key)
    }
  }

  const hasRoomFor = (key: string): boolean => {
    if (failures.has(key) || failures.size < maxKeys) return true
    pruneExpired()
    return failures.size < maxKeys
  }

  return {
    check: (key) => hasRoomFor(key) && recent(key).length < o.max,
    fail(key) {
      if (!hasRoomFor(key)) return
      const times = [...recent(key), now()].slice(-o.max)
      failures.delete(key)
      failures.set(key, times)
    },
    reset: (key) => void failures.delete(key),
    size: () => failures.size,
  }
}

export const LOGIN_WINDOW_MS = 15 * 60_000

export type LoginLimits = {
  /** 10 failures per IP + email in 15 minutes (key: loginKey()). */
  perEmail: LoginLimiter
  /** 50 failures per IP in 15 minutes, whatever the emails (key: clientIp()). */
  perIp: LoginLimiter
}

/** `maxKeys` (for tests) bounds both limiters; by default per-email holds 100 000 keys and per-IP 10 000. */
export function createLoginLimits(o: { now?: () => number; maxKeys?: number } = {}): LoginLimits {
  return {
    perEmail: createLoginLimiter({ max: 10, windowMs: LOGIN_WINDOW_MS, now: o.now, maxKeys: o.maxKeys ?? PER_EMAIL_MAX_KEYS }),
    perIp: createLoginLimiter({ max: 50, windowMs: LOGIN_WINDOW_MS, now: o.now, maxKeys: o.maxKeys ?? DEFAULT_MAX_KEYS }),
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

const LIMITS_KEY = Symbol.for('vpsm.web.loginLimits')

// The process's login limits. Kept on globalThis so that every bundle of the server (and a dev server reloading
// modules) shares one set of counters.
export function loginLimits(): LoginLimits {
  const holder = globalThis as { [LIMITS_KEY]?: LoginLimits }
  return (holder[LIMITS_KEY] ??= createLoginLimits())
}
