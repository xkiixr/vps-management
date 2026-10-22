import { expect, test } from 'vitest'
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
  })
})

test('reads every variable from the environment', () => {
  expect(
    loadConfig({
      APPS_DOMAIN: 'paas.example.org',
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
      GITHUB_TOKEN: 'ghs_abc',
    }),
  ).toEqual({
    appsDomain: 'paas.example.org',
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
    githubToken: 'ghs_abc',
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
])('%s=%s is rejected', (name, value) => {
  expect(() => loadConfig({ APPS_DOMAIN: 'apps.example.com', [name]: value })).toThrow(new RegExp(name))
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
