import { describe, expect, test } from 'vitest'
import { assertSameOrigin, ForbiddenError } from '@/server/origin'

const PANEL = 'https://panel.x.duckdns.org:8443'

describe('assertSameOrigin', () => {
  test('assertSameOrigin accepts only the exact panel origin', () => {
    const ok = new Headers({ origin: 'https://panel.x.duckdns.org:8443' })
    expect(() => assertSameOrigin(ok, 'https://panel.x.duckdns.org:8443')).not.toThrow()
    for (const o of ['https://hello-demo.x.duckdns.org:8443', 'https://panel.x.duckdns.org', 'null', ''])
      expect(() => assertSameOrigin(new Headers(o ? { origin: o } : {}), 'https://panel.x.duckdns.org:8443')).toThrow(
        'cross-origin request refused',
      )
  })

  test('refuses near misses: trailing slash, other scheme, other case, a path, an empty Origin header', () => {
    for (const o of [
      'https://panel.x.duckdns.org:8443/',
      'http://panel.x.duckdns.org:8443',
      'HTTPS://panel.x.duckdns.org:8443',
      'https://PANEL.x.duckdns.org:8443',
      'https://panel.x.duckdns.org:8443/login',
      'https://panel.x.duckdns.org:84430',
      'https://evil.example',
    ]) {
      expect(() => assertSameOrigin(new Headers({ origin: o }), PANEL), o).toThrow('cross-origin request refused')
    }
    expect(() => assertSameOrigin({ get: () => '' }, PANEL)).toThrow('cross-origin request refused')
  })

  test('throws a ForbiddenError', () => {
    let caught: unknown
    try {
      assertSameOrigin(new Headers(), PANEL)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ForbiddenError)
    expect((caught as Error).name).toBe('ForbiddenError')
  })

  test('never matches when the configured origin is empty', () => {
    expect(() => assertSameOrigin({ get: () => '' }, '')).toThrow('cross-origin request refused')
  })
})
