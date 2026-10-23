import { describe, expect, test } from 'vitest'
import { config } from '@/proxy'

// How Next applies a matcher: the whole path has to match it.
const matcher = new RegExp(`^${config.matcher[0]}$`)

describe('the session proxy', () => {
  test.each(['/', '/login', '/projects/smoke', '/projects/smoke/services/web', '/api/deployments/abc/logs', '/api/github'])(
    'runs for %s',
    (path) => {
      expect(matcher.test(path)).toBe(true)
    },
  )

  test.each(['/_next/static/chunks/main.js', '/_next/image', '/favicon.ico'])('does not run for the assets at %s', (path) => {
    expect(matcher.test(path)).toBe(false)
  })

  // GitHub is not a browser with a session, and Next reads the body of a request the proxy sees before the route can
  // check its signature.
  test('never runs for the GitHub webhook, but does for other paths that only start like it', () => {
    expect(matcher.test('/api/github/webhook')).toBe(false)
    expect(matcher.test('/api/github/webhook/')).toBe(false)
    expect(matcher.test('/api/github/webhooks')).toBe(true)
    expect(matcher.test('/api/github/webhook-test')).toBe(true)
    expect(matcher.test('/projects/api/github/webhook')).toBe(true)
  })
})
