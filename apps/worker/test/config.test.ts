import { describe, expect, test } from 'vitest'
import { loadConfig } from '../src/config'

test('defaults and required APPS_DOMAIN', () => {
  expect(loadConfig({ APPS_DOMAIN: 'apps.example.com' })).toMatchObject({
    memoryBudgetMb: 5632,
    maxServiceMemoryMb: 2048,
    buildTimeoutMs: 1_200_000,
    drainSeconds: 10,
    imageRetention: 5,
    frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0',
  })
  expect(() => loadConfig({})).toThrow(/APPS_DOMAIN/)
})

test('every default', () => {
  expect(loadConfig({ APPS_DOMAIN: 'apps.example.com' })).toEqual({
    appsDomain: 'apps.example.com',
    traefikDynamicDir: '/traefik/dynamic',
    traefikContainer: 'vpsm-traefik',
    workerContainer: 'vpsm-worker',
    frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0',
    memoryBudgetMb: 5632,
    maxServiceMemoryMb: 2048,
    buildTimeoutMs: 1_200_000,
    drainSeconds: 10,
    imageRetention: 5,
    workDir: '/var/lib/vpsm/work',
    tlsMode: 'http01',
    publicHttpsPort: 443,
    panelUpstream: 'http://vpsm-web:3000',
  })
})

test('reads every variable from the environment', () => {
  expect(
    loadConfig({
      APPS_DOMAIN: 'paas.duckdns.org',
      TRAEFIK_DYNAMIC_DIR: '/etc/traefik/dyn',
      TRAEFIK_CONTAINER: 'my-traefik',
      WORKER_CONTAINER: 'my-worker',
      RAILPACK_FRONTEND_IMAGE: 'registry.example.org/frontend:v1',
      MEMORY_BUDGET_MB: '4096',
      MAX_SERVICE_MEMORY_MB: '1024',
      BUILD_TIMEOUT_MINUTES: '5',
      DRAIN_SECONDS: '0',
      IMAGE_RETENTION: '3',
      WORK_DIR: '/data/work',
      TLS_MODE: 'dns-wildcard',
      PUBLIC_HTTPS_PORT: '8443',
      GITHUB_TOKEN: 'ghs_abc',
      PANEL_DOMAIN: 'panel.paas.duckdns.org',
      PANEL_UPSTREAM: 'http://my-web:4000',
    }),
  ).toEqual({
    appsDomain: 'paas.duckdns.org',
    traefikDynamicDir: '/etc/traefik/dyn',
    traefikContainer: 'my-traefik',
    workerContainer: 'my-worker',
    frontendImage: 'registry.example.org/frontend:v1',
    memoryBudgetMb: 4096,
    maxServiceMemoryMb: 1024,
    buildTimeoutMs: 300_000,
    drainSeconds: 0,
    imageRetention: 3,
    workDir: '/data/work',
    tlsMode: 'dns-wildcard',
    publicHttpsPort: 8443,
    githubToken: 'ghs_abc',
    panelDomain: 'panel.paas.duckdns.org',
    panelUpstream: 'http://my-web:4000',
  })
})

test('an empty variable counts as unset', () => {
  const config = loadConfig({ APPS_DOMAIN: 'apps.example.com', GITHUB_TOKEN: '', MEMORY_BUDGET_MB: '' })
  expect(config.githubToken).toBeUndefined()
  expect(config.memoryBudgetMb).toBe(5632)
  expect(() => loadConfig({ APPS_DOMAIN: '' })).toThrow(/APPS_DOMAIN/)
})

test.each(['localhost', 'Apps.Example.com', 'apps..example.com', 'https://apps.example.com'])(
  'APPS_DOMAIN %s is rejected',
  (domain) => {
    expect(() => loadConfig({ APPS_DOMAIN: domain })).toThrow(/APPS_DOMAIN/)
  },
)

test.each([
  ['MEMORY_BUDGET_MB', 'lots'],
  ['MAX_SERVICE_MEMORY_MB', '0'],
  ['BUILD_TIMEOUT_MINUTES', '1.5'],
  ['DRAIN_SECONDS', '-1'],
  ['IMAGE_RETENTION', '0'],
  ['WORK_DIR', 'relative/work'],
  ['TRAEFIK_DYNAMIC_DIR', 'traefik'],
  ['TLS_MODE', 'dns'],
  ['TLS_MODE', 'DNS-WILDCARD'],
  ['PUBLIC_HTTPS_PORT', '0'],
  ['PUBLIC_HTTPS_PORT', '65536'],
  ['PUBLIC_HTTPS_PORT', '84.43'],
  ['PUBLIC_HTTPS_PORT', 'https'],
])('%s=%s is rejected', (name, value) => {
  expect(() => loadConfig({ APPS_DOMAIN: 'apps.example.com', [name]: value })).toThrow(new RegExp(name))
})

test('TLS_MODE accepts both modes and PUBLIC_HTTPS_PORT the whole port range', () => {
  const load = (env: Record<string, string>) => loadConfig({ APPS_DOMAIN: 'apps.example.com', ...env })
  const wildcard = { TLS_MODE: 'dns-wildcard', APPS_DOMAIN: 'apps.duckdns.org' }
  expect(load({ TLS_MODE: 'http01' }).tlsMode).toBe('http01')
  expect(load(wildcard).tlsMode).toBe('dns-wildcard')
  expect(load({ ...wildcard, PUBLIC_HTTPS_PORT: '1' }).publicHttpsPort).toBe(1)
  expect(load({ ...wildcard, PUBLIC_HTTPS_PORT: '65535' }).publicHttpsPort).toBe(65535)
  expect(load({ TLS_MODE: '', PUBLIC_HTTPS_PORT: '' })).toMatchObject({ tlsMode: 'http01', publicHttpsPort: 443 })
  expect(load({ TLS_MODE: 'http01', PUBLIC_HTTPS_PORT: '443' })).toMatchObject({ tlsMode: 'http01', publicHttpsPort: 443 })
})

describe('the TLS settings only make sense together', () => {
  const load = (env: Record<string, string>) => () => loadConfig({ APPS_DOMAIN: 'apps.example.com', ...env })

  test.each(['1', '80', '8443', '65535'])('http01 with PUBLIC_HTTPS_PORT=%s is rejected', (port) => {
    expect(load({ PUBLIC_HTTPS_PORT: port })).toThrow(/^invalid worker configuration: PUBLIC_HTTPS_PORT .*TLS_MODE/)
    expect(load({ TLS_MODE: 'http01', PUBLIC_HTTPS_PORT: port })).toThrow(/PUBLIC_HTTPS_PORT/)
  })

  test('dns-wildcard accepts port 443 as well as another port', () => {
    const env = { TLS_MODE: 'dns-wildcard', APPS_DOMAIN: 'apps.duckdns.org' }
    expect(load({ ...env, PUBLIC_HTTPS_PORT: '443' })().publicHttpsPort).toBe(443)
    expect(load({ ...env, PUBLIC_HTTPS_PORT: '8443' })().publicHttpsPort).toBe(8443)
    expect(load(env)().publicHttpsPort).toBe(443)
  })

  test.each(['apps.example.com', 'duckdns.org', 'apps.duckdns.org.example.com', 'apps-duckdns.org', 'xduckdns.org'])(
    'dns-wildcard with APPS_DOMAIN=%s (not a DuckDNS name) is rejected',
    (domain) => {
      expect(load({ TLS_MODE: 'dns-wildcard', PUBLIC_HTTPS_PORT: '8443', APPS_DOMAIN: domain })).toThrow(
        /^invalid worker configuration: APPS_DOMAIN .*TLS_MODE/,
      )
    },
  )

  test('http01 does not care which domain it is', () => {
    expect(load({ APPS_DOMAIN: 'apps.duckdns.org' })().tlsMode).toBe('http01')
  })

  test('the errors name the variables without echoing any value', () => {
    let message = ''
    try {
      loadConfig({ APPS_DOMAIN: 'secretish.example.com', TLS_MODE: 'dns-wildcard', PUBLIC_HTTPS_PORT: '9999' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/APPS_DOMAIN/)
    expect(message).toMatch(/TLS_MODE/)
    expect(message).not.toContain('secretish')
    expect(message).not.toContain('9999')
    try {
      loadConfig({ APPS_DOMAIN: 'apps.example.com', PUBLIC_HTTPS_PORT: '9999' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/PUBLIC_HTTPS_PORT/)
    expect(message).not.toContain('9999')
  })
})

describe('the panel settings', () => {
  const load = (env: Record<string, string>) => () => loadConfig({ APPS_DOMAIN: 'apps.example.com', ...env })

  test('the panel is optional and its upstream defaults to the web container', () => {
    const config = load({})()
    expect(config.panelDomain).toBeUndefined()
    expect('panelDomain' in config).toBe(false)
    expect(config.panelUpstream).toBe('http://vpsm-web:3000')
  })

  test('PANEL_DOMAIN is read as given', () => {
    expect(load({ PANEL_DOMAIN: 'panel.apps.example.com' })().panelDomain).toBe('panel.apps.example.com')
  })

  test('an empty PANEL_DOMAIN or PANEL_UPSTREAM counts as unset', () => {
    const config = load({ PANEL_DOMAIN: '', PANEL_UPSTREAM: '' })()
    expect(config.panelDomain).toBeUndefined()
    expect(config.panelUpstream).toBe('http://vpsm-web:3000')
  })

  test.each(['Bad Host', 'Panel.Example.com', 'localhost', 'panel..example.com', 'https://panel.example.com'])(
    'PANEL_DOMAIN %s must be a valid hostname',
    (domain) => {
      expect(load({ PANEL_DOMAIN: domain })).toThrow(/^invalid worker configuration: PANEL_DOMAIN /)
    },
  )

  test.each([
    'vpsm-web:3000',
    'https://vpsm-web:3000',
    'http://vpsm-web',
    'http://vpsm-web:3000/',
    'http://vpsm-web:3000/app',
    'http://VPSM-web:3000',
    'http://vpsm_web:3000',
    'http://user@vpsm-web:3000',
    'http://vpsm-web:port',
  ])('PANEL_UPSTREAM %s is rejected', (upstream) => {
    expect(load({ PANEL_UPSTREAM: upstream })).toThrow(/^invalid worker configuration: PANEL_UPSTREAM /)
  })

  test('PANEL_UPSTREAM accepts a container name and port', () => {
    expect(load({ PANEL_UPSTREAM: 'http://panel-1:8080' })().panelUpstream).toBe('http://panel-1:8080')
  })

  test('the errors name the variable without echoing its value', () => {
    for (const env of [{ PANEL_DOMAIN: 'Secretish Host' }, { PANEL_UPSTREAM: 'http://secretish_host:3000' }]) {
      let message = ''
      try {
        loadConfig({ APPS_DOMAIN: 'apps.example.com', ...env })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toMatch(/PANEL_/)
      expect(message).not.toContain('ecretish')
    }
  })
})

// The wildcard certificate (*.APPS_DOMAIN) covers exactly one label, so a panel anywhere else would be served
// with a certificate for another name.
describe('PANEL_DOMAIN with the wildcard certificate (TLS_MODE=dns-wildcard)', () => {
  const wildcard = { APPS_DOMAIN: 'paas.duckdns.org', TLS_MODE: 'dns-wildcard', PUBLIC_HTTPS_PORT: '8443' }

  test('a single label under APPS_DOMAIN is accepted', () => {
    expect(loadConfig({ ...wildcard, PANEL_DOMAIN: 'panel.paas.duckdns.org' }).panelDomain).toBe('panel.paas.duckdns.org')
  })

  test('PANEL_DOMAIN stays optional', () => {
    expect(loadConfig(wildcard).panelDomain).toBeUndefined()
    expect(loadConfig({ ...wildcard, PANEL_DOMAIN: '' }).panelDomain).toBeUndefined()
  })

  test.each([
    ['two labels under APPS_DOMAIN', 'a.panel.paas.duckdns.org'],
    ['APPS_DOMAIN itself', 'paas.duckdns.org'],
    ['another domain', 'panel.example.com'],
    ['a name that only ends like APPS_DOMAIN', 'panelpaas.duckdns.org'],
    ['a sibling DuckDNS name', 'panel.other.duckdns.org'],
  ])('%s is a configuration error that names both variables and echoes no value', (_what, panelDomain) => {
    let message = ''
    try {
      loadConfig({ ...wildcard, PANEL_DOMAIN: panelDomain })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/^invalid worker configuration: PANEL_DOMAIN must be a single label under APPS_DOMAIN/)
    expect(message).not.toContain(panelDomain)
    expect(message).not.toContain('paas')
  })

  test('without the wildcard certificate the panel may live anywhere', () => {
    const load = (domain: string) => loadConfig({ APPS_DOMAIN: 'apps.example.com', PANEL_DOMAIN: domain }).panelDomain
    expect(load('panel.example.org')).toBe('panel.example.org')
    expect(load('a.b.apps.example.com')).toBe('a.b.apps.example.com')
  })
})

test('the error never contains the token', () => {
  let message = ''
  try {
    loadConfig({ GITHUB_TOKEN: 'ghs_secret' })
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toMatch(/APPS_DOMAIN/)
  expect(message).not.toContain('ghs_secret')
})

describe('WORK_DIR is emptied at startup, so it must be a dedicated directory', () => {
  const load = (env: Record<string, string>) => () => loadConfig({ APPS_DOMAIN: 'apps.example.com', ...env })

  test.each(['/', '//', '/work', '/var/lib/..', '/var/../work/'])(
    'WORK_DIR=%s (a root or top-level directory) is rejected',
    (dir) => {
      expect(load({ WORK_DIR: dir })).toThrow(/WORK_DIR/)
    },
  )

  test.each([
    ['/traefik/dynamic', '/traefik/dynamic'],
    ['/traefik/dynamic/', '/traefik/dynamic'],
    ['/traefik/dynamic/work', '/traefik/dynamic'],
    ['/srv/vpsm', '/srv/vpsm/traefik'],
    ['/srv/vpsm/x/../traefik', '/srv/vpsm/traefik'],
  ])('WORK_DIR=%s overlapping TRAEFIK_DYNAMIC_DIR=%s is rejected', (workDir, traefikDir) => {
    expect(load({ WORK_DIR: workDir, TRAEFIK_DYNAMIC_DIR: traefikDir })).toThrow(/WORK_DIR/)
  })

  test.each([
    ['/var/lib/vpsm/work', '/traefik/dynamic'],
    ['/data/work', '/data/traefik'],
    ['/srv/vpsm/traefik-work', '/srv/vpsm/traefik'],
  ])('WORK_DIR=%s next to TRAEFIK_DYNAMIC_DIR=%s is accepted', (workDir, traefikDir) => {
    expect(load({ WORK_DIR: workDir, TRAEFIK_DYNAMIC_DIR: traefikDir })().workDir).toBe(workDir)
  })

  test('the error names WORK_DIR without echoing any value', () => {
    let message = ''
    try {
      loadConfig({ APPS_DOMAIN: 'apps.example.com', WORK_DIR: '/srv/secretish/dyn', TRAEFIK_DYNAMIC_DIR: '/srv/secretish/dyn' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/WORK_DIR/)
    expect(message).not.toContain('secretish')
  })

  test('a relative WORK_DIR gets one clear message', () => {
    expect(load({ WORK_DIR: 'relative/work' })).toThrow(
      /^invalid worker configuration: WORK_DIR must be an absolute path$/,
    )
  })
})
