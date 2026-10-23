import { describe, expect, test } from 'vitest'
import { webConfig } from '@/server/config'

const SECRET = 's3cr3t-pw'
const base = {
  DATABASE_URL: `postgres://postgres:${SECRET}@postgres:5432/postgres`,
  APPS_DOMAIN: 'x.duckdns.org',
  PANEL_DOMAIN: 'panel.x.duckdns.org',
}

function configError(env: Record<string, string>): string {
  try {
    webConfig(env)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected webConfig to throw')
}

describe('webConfig', () => {
  test('webConfig builds the origin with the port', () => {
    expect(webConfig({ ...base, PUBLIC_HTTPS_PORT: '8443' })).toEqual({
      databaseUrl: base.DATABASE_URL,
      appsDomain: 'x.duckdns.org',
      panelDomain: 'panel.x.duckdns.org',
      httpsPort: 8443,
      panelOrigin: 'https://panel.x.duckdns.org:8443',
    })
  })

  test('leaves the default HTTPS port (443) out of the origin', () => {
    expect(webConfig(base)).toMatchObject({ httpsPort: 443, panelOrigin: 'https://panel.x.duckdns.org' })
    expect(webConfig({ ...base, PUBLIC_HTTPS_PORT: '' })).toMatchObject({ httpsPort: 443 })
  })

  test('PANEL_ORIGIN overrides the derived origin (dev and e2e)', () => {
    expect(webConfig({ ...base, PANEL_ORIGIN: 'http://localhost:3100' }).panelOrigin).toBe('http://localhost:3100')
  })

  test('PANEL_ORIGIN must be a bare origin', () => {
    for (const bad of ['http://localhost:3100/', 'localhost:3100', 'https://panel.x.duckdns.org/login', 'ftp://x.org', 'https://user@x.org']) {
      expect(configError({ ...base, PANEL_ORIGIN: bad }), bad).toMatch(/PANEL_ORIGIN/)
    }
  })

  test('GITHUB_WEBHOOK_SECRET is optional, and empty counts as not set', () => {
    expect(webConfig(base).githubWebhookSecret).toBeUndefined()
    expect(webConfig({ ...base, GITHUB_WEBHOOK_SECRET: '' }).githubWebhookSecret).toBeUndefined()
    expect(webConfig({ ...base, GITHUB_WEBHOOK_SECRET: 'x'.repeat(16) }).githubWebhookSecret).toBe('x'.repeat(16))
  })

  test('GITHUB_WEBHOOK_SECRET must be at least 16 characters, and the message does not repeat it', () => {
    const short = 'abcdefghijklmno'
    const message = configError({ ...base, GITHUB_WEBHOOK_SECRET: short })
    expect(message).toContain('GITHUB_WEBHOOK_SECRET must be at least 16 characters')
    expect(message).not.toContain(short)
  })

  test('names every missing or invalid variable', () => {
    const message = configError({})
    for (const name of ['DATABASE_URL', 'APPS_DOMAIN', 'PANEL_DOMAIN']) expect(message).toContain(name)

    expect(configError({ ...base, APPS_DOMAIN: 'Not A Host' })).toMatch(/APPS_DOMAIN/)
    expect(configError({ ...base, PANEL_DOMAIN: 'panel' })).toMatch(/PANEL_DOMAIN/)
    for (const port of ['abc', '0', '70000', '8443.5']) {
      expect(configError({ ...base, PUBLIC_HTTPS_PORT: port }), port).toMatch(/PUBLIC_HTTPS_PORT/)
    }
  })

  test('never prints a value, so a bad DATABASE_URL does not leak its password', () => {
    const message = configError({ ...base, DATABASE_URL: `mysql://root:${SECRET}@db/app` })
    expect(message).toMatch(/DATABASE_URL/)
    expect(message).not.toContain(SECRET)
  })
})
