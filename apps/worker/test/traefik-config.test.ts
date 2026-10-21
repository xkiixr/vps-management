import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { renderRoutesYaml, writeRoutesFile } from '../src/routing/traefik-config'

test('renders router and service per instance', () => {
  expect(
    renderRoutesYaml([
      { serviceInstanceId: 'si1', hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-12345678:8080' },
    ]),
  ).toBe(
    `http:
  routers:
    r-si1:
      rule: Host(\`web-shop.apps.example.com\`)
      entryPoints:
        - websecure
      service: s-si1
      tls:
        certResolver: le
  services:
    s-si1:
      loadBalancer:
        servers:
          - url: http://vpsm-web-12345678:8080
`,
  )
})

test('renders one router and service per route, in the given order', () => {
  const yaml = renderRoutesYaml([
    { serviceInstanceId: 'si1', hostnames: ['a.example.com'], upstreamUrl: 'http://one:1' },
    { serviceInstanceId: 'si2', hostnames: ['b.example.com'], upstreamUrl: 'http://two:2' },
  ])
  expect(yaml).toContain('    r-si1:\n')
  expect(yaml).toContain('    r-si2:\n')
  expect(yaml).toContain('    s-si1:\n')
  expect(yaml).toContain('    s-si2:\n')
  expect(yaml.indexOf('r-si1')).toBeLessThan(yaml.indexOf('r-si2'))
  expect(yaml).toContain('- url: http://one:1\n')
  expect(yaml).toContain('- url: http://two:2\n')
})

test('multiple hostnames are OR-ed in sorted order', () => {
  expect(renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['b.example.com', 'a.example.com'], upstreamUrl: 'http://x:1' }])).toContain(
    'rule: Host(`a.example.com`) || Host(`b.example.com`)',
  )
})

test('a rule with many hostnames stays on a single line', () => {
  const hostnames = Array.from({ length: 20 }, (_, i) => `service-number-${i}.apps.example.com`)
  const yaml = renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames, upstreamUrl: 'http://x:1' }])
  expect(yaml).toContain(`      rule: ${[...hostnames].sort().map((h) => `Host(\`${h}\`)`).join(' || ')}\n      entryPoints:`)
})

test('does not reorder the caller hostnames array', () => {
  const hostnames = ['b.example.com', 'a.example.com']
  renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames, upstreamUrl: 'http://x:1' }])
  expect(hostnames).toEqual(['b.example.com', 'a.example.com'])
})

test('empty route list is still valid config', () => {
  expect(renderRoutesYaml([])).toBe('http:\n  routers: {}\n  services: {}\n')
})

test('refuses hostnames that could inject Traefik rules', () => {
  expect(() =>
    renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['a`) || Host(`evil.com'], upstreamUrl: 'http://x:1' }]),
  ).toThrow('invalid hostname: a`) || Host(`evil.com')
})

test('refuses a bad hostname even when other hostnames are fine', () => {
  expect(() =>
    renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['ok.example.com', 'UPPER.example.com'], upstreamUrl: 'http://x:1' }]),
  ).toThrow('invalid hostname')
})

test.each(['si1\nr-evil', 'SI1', 'si_1', 'si 1', ''])('refuses service instance id %j', (serviceInstanceId) => {
  expect(() => renderRoutesYaml([{ serviceInstanceId, hostnames: ['a.example.com'], upstreamUrl: 'http://x:1' }])).toThrow('invalid route')
})

test.each(['https://x:1', 'http://x', 'http://x:1/path', 'http://x:1\n  - url: http://evil:1', 'http://X:1', 'x:1', ''])(
  'refuses upstream url %j',
  (upstreamUrl) => {
    expect(() => renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['a.example.com'], upstreamUrl }])).toThrow('invalid route')
  },
)

test('refuses a route without hostnames', () => {
  expect(() => renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: [], upstreamUrl: 'http://x:1' }])).toThrow('invalid route')
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vpsm-routes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('writeRoutesFile replaces atomically and leaves no tmp file', async () => {
  await writeRoutesFile(dir, 'first\n')
  await writeRoutesFile(dir, 'second\n')

  expect(await readdir(dir)).toEqual(['routes.yml'])
  expect(await readFile(join(dir, 'routes.yml'), 'utf8')).toBe('second\n')
})

test('writeRoutesFile creates the directory when it is missing', async () => {
  const nested = join(dir, 'a', 'b')
  await writeRoutesFile(nested, 'content\n')

  expect(await readdir(nested)).toEqual(['routes.yml'])
  expect(await readFile(join(nested, 'routes.yml'), 'utf8')).toBe('content\n')
})
