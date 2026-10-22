import { describe, expect, test } from 'vitest'
import { clientIp, createLoginLimiter, loginKey } from '@/server/rate-limit'

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

  test('keeps at most maxKeys keys, evicting the one that failed least recently', () => {
    const limiter = createLoginLimiter({ max: 1, windowMs: WINDOW_MS, maxKeys: 3 })
    limiter.fail('a')
    limiter.fail('b')
    limiter.fail('c')
    limiter.fail('a') // refreshes "a": "b" is now the oldest
    limiter.fail('d') // a fourth key evicts "b"
    expect(limiter.check('a')).toBe(false)
    expect(limiter.check('b')).toBe(true)
    expect(limiter.check('c')).toBe(false)
    expect(limiter.check('d')).toBe(false)
    expect(limiter.size()).toBe(3)
  })

  test('the default bound is 10 000 keys', () => {
    const limiter = createLoginLimiter({ max: 10, windowMs: WINDOW_MS })
    for (let n = 0; n < 10_050; n++) limiter.fail(`key-${n}`)
    expect(limiter.size()).toBe(10_000)
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
