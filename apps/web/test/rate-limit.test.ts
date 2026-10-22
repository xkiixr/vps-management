import { describe, expect, test } from 'vitest'
import { clientIp, createLoginLimiter, createLoginLimits, loginKey } from '@/server/rate-limit'

const WINDOW_MS = 15 * 60_000

function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('createLoginLimiter', () => {
  test('limiter blocks the 11th failure inside the window and resets on success', () => {
    const clock = fakeClock()
    const limiter = createLoginLimiter({ max: 10, windowMs: WINDOW_MS, now: clock.now })
    const key = '203.0.113.7|a@example.com'

    for (let n = 1; n <= 10; n++) {
      expect(limiter.check(key), `attempt ${n}`).toBe(true)
      limiter.fail(key)
      clock.advance(60_000)
    }
    expect(limiter.check(key)).toBe(false)

    limiter.reset(key)
    expect(limiter.check(key)).toBe(true)
  })

  test('failures older than the window stop counting', () => {
    const clock = fakeClock()
    const limiter = createLoginLimiter({ max: 10, windowMs: WINDOW_MS, now: clock.now })
    const key = 'k'
    limiter.fail(key) // t = 0
    clock.advance(5 * 60_000)
    for (let n = 0; n < 9; n++) limiter.fail(key) // t = 5 min
    expect(limiter.check(key)).toBe(false)

    clock.advance(10 * 60_000 - 1) // the first failure is 1 ms short of 15 minutes old
    expect(limiter.check(key)).toBe(false)
    clock.advance(1) // now it has left the window: 9 failures remain
    expect(limiter.check(key)).toBe(true)
    limiter.fail(key)
    expect(limiter.check(key)).toBe(false)

    clock.advance(5 * 60_000) // the other nine left the window too
    expect(limiter.check(key)).toBe(true)
  })

  test('keys are independent', () => {
    const limiter = createLoginLimiter({ max: 2, windowMs: WINDOW_MS })
    limiter.fail('a')
    limiter.fail('a')
    expect(limiter.check('a')).toBe(false)
    expect(limiter.check('b')).toBe(true)
  })

  test('junk keys cannot push out a blocked key: once full of live keys, new keys are refused instead', () => {
    const clock = fakeClock()
    const limiter = createLoginLimiter({ max: 1, windowMs: WINDOW_MS, maxKeys: 3, now: clock.now })
    limiter.fail('203.0.113.7|victim@example.com')
    expect(limiter.check('203.0.113.7|victim@example.com')).toBe(false)

    for (let n = 0; n < 100; n++) {
      const junk = `203.0.113.7|junk-${n}@example.com`
      if (limiter.check(junk)) limiter.fail(junk)
      clock.advance(1000)
    }
    expect(limiter.size()).toBe(3)
    expect(limiter.check('203.0.113.7|junk-99@example.com')).toBe(false) // no room: refused
    limiter.fail('203.0.113.7|junk-99@example.com') // and not recorded either
    expect(limiter.size()).toBe(3)
    expect(limiter.check('203.0.113.7|victim@example.com')).toBe(false)
  })

  test('expired keys are pruned to make room, oldest latest-failure first, never a live key', () => {
    const clock = fakeClock()
    const limiter = createLoginLimiter({ max: 1, windowMs: WINDOW_MS, maxKeys: 2, now: clock.now })
    limiter.fail('a') // t = 0
    clock.advance(60_000)
    limiter.fail('b') // t = 1 min
    clock.advance(60_000)
    limiter.fail('a') // t = 2 min: "a" failed again, so "b" now has the oldest latest failure
    expect(limiter.check('c')).toBe(false) // full, nothing expired

    clock.advance(WINDOW_MS - 60_000) // t = 16 min: "b" (1 min) has expired, "a" (2 min) has not
    expect(limiter.check('c')).toBe(true)
    limiter.fail('c')
    expect(limiter.size()).toBe(2)
    expect(limiter.check('a')).toBe(false) // still blocked: a live key is never dropped
    expect(limiter.check('c')).toBe(false)
  })

  test('the default bound is 10 000 keys', () => {
    const limiter = createLoginLimiter({ max: 10, windowMs: WINDOW_MS })
    for (let n = 0; n < 10_050; n++) limiter.fail(`key-${n}`)
    expect(limiter.size()).toBe(10_000)
    expect(limiter.check('key-0')).toBe(true) // known key, one failure
    expect(limiter.check('key-10049')).toBe(false) // never got in
  })
})

describe('createLoginLimits', () => {
  test('10 failures per IP and email, 50 per IP, over 15 minutes', () => {
    const clock = fakeClock()
    const limits = createLoginLimits({ now: clock.now })
    for (let n = 0; n < 10; n++) limits.perEmail.fail('ip|a@example.com')
    expect(limits.perEmail.check('ip|a@example.com')).toBe(false)
    for (let n = 0; n < 49; n++) limits.perIp.fail('203.0.113.7')
    expect(limits.perIp.check('203.0.113.7')).toBe(true)
    limits.perIp.fail('203.0.113.7')
    expect(limits.perIp.check('203.0.113.7')).toBe(false)
    clock.advance(WINDOW_MS)
    expect(limits.perIp.check('203.0.113.7')).toBe(true)
    expect(limits.perEmail.check('ip|a@example.com')).toBe(true)
  })

  // One address may make up to 50 per-email keys per window before its own limit stops it; at 10 000 keys, 200
  // addresses could fill the per-email limiter and lock every new sign-in out (a full limiter refuses new keys).
  test('the per-email limiter holds 100 000 keys, the per-IP limiter 10 000, and neither evicts a live key', () => {
    const limits = createLoginLimits()
    for (let n = 0; n < 100_050; n++) limits.perEmail.fail(`203.0.113.${n % 256}|user-${n}@example.com`)
    expect(limits.perEmail.size()).toBe(100_000)
    expect(limits.perEmail.check('203.0.113.0|user-0@example.com')).toBe(true) // known key, one failure
    expect(limits.perEmail.check('203.0.113.1|user-100049@example.com')).toBe(false) // never got in

    for (let n = 0; n < 10_050; n++) limits.perIp.fail(`198.51.100.${n}`)
    expect(limits.perIp.size()).toBe(10_000)
    expect(limits.perIp.check('198.51.100.10049')).toBe(false)
  })

  test('a maxKeys given for tests bounds both limiters', () => {
    const limits = createLoginLimits({ maxKeys: 2 })
    for (const key of ['a', 'b', 'c']) {
      limits.perEmail.fail(key)
      limits.perIp.fail(key)
    }
    expect([limits.perEmail.size(), limits.perIp.size()]).toEqual([2, 2])
  })
})

describe('clientIp', () => {
  test('takes the first X-Forwarded-For entry', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.2, 10.0.0.3' }))).toBe('203.0.113.7')
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1, 10.0.0.2' }))).toBe('2001:db8::1')
  })

  test('falls back to "unknown" when the header is missing or its first entry is not an IP address', () => {
    expect(clientIp(new Headers())).toBe('unknown')
    expect(clientIp(new Headers({ 'x-forwarded-for': '' }))).toBe('unknown')
    expect(clientIp(new Headers({ 'x-forwarded-for': ', 203.0.113.7' }))).toBe('unknown')
    expect(clientIp(new Headers({ 'x-forwarded-for': 'x'.repeat(5000) }))).toBe('unknown')
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7:51234' }))).toBe('unknown')
  })
})

describe('loginKey', () => {
  test('is ip|email with the email normalised like stored emails', () => {
    expect(loginKey('203.0.113.7', '  Alice@Example.COM ')).toBe('203.0.113.7|alice@example.com')
  })
})
