import { describe, expect, test } from 'vitest'
import nextConfig from '../next.config'

// The panel is same-site with the team's apps (panel.<APPS_DOMAIN> beside <service>-<project>.<APPS_DOMAIN>), so
// any of them could frame it, and a click inside that frame would carry the panel's own Origin and its SameSite=Lax
// cookie past every check of a server action. No page of the panel may be framed, by anyone.
describe('security headers', () => {
  test('every path is sent with headers that forbid framing, MIME sniffing and cross-origin referrers', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const all = rules.filter((rule) => rule.source === '/:path*')
    expect(all).toHaveLength(1)
    const headers = Object.fromEntries(all[0]!.headers.map(({ key, value }) => [key, value]))
    expect(headers).toEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    })
  })

  test('the rule applies to every request: no condition limits it', async () => {
    const [rule] = ((await nextConfig.headers?.()) ?? []).filter((r) => r.source === '/:path*')
    expect(rule).toBeDefined()
    expect(rule!.has).toBeUndefined()
    expect(rule!.missing).toBeUndefined()
    expect(rule!.basePath).toBeUndefined()
    expect(rule!.locale).toBeUndefined()
  })
})
