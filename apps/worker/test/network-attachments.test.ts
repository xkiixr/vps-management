import fs from 'node:fs'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { networkName } from '@vpsm/core'
import { createAppService, createProject, enqueueDeployment, markDeploymentLive, setDeploymentStatus } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { ensureNetworkAttachments } from '../src/monitor/network-attachments'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instances: Record<string, { id: string; net: string }>

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  instances = {}
  deps = fakeDeps(db)
  for (const project of ['shop', 'blog', 'idle']) await createProject(db, project)
  for (const [project, service] of [
    ['shop', 'web'],
    ['shop', 'api'],
    ['blog', 'site'],
    ['idle', 'job'],
  ] as const) {
    const { instance } = await createAppService(db, {
      projectName: project,
      serviceName: service,
      source: { repo: `acme/${service}`, branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    const net = networkName(instance.environmentId)
    await deps.docker.ensureNetwork(net)
    instances[service] = { id: instance.id, net }
  }
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function goLive(service: string): Promise<void> {
  const d = await enqueueDeployment(db, { serviceInstanceId: instances[service]!.id, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'BUILDING')
  await setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: `vpsm/${instances[service]!.id}:${d.id}` })
  await markDeploymentLive(db, { deploymentId: d.id, containerName: `vpsm-${service}-live` })
}

const sorted = (pairs: [string, string][]) => [...pairs].sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`))
const expectedFor = (...services: string[]) =>
  sorted(services.flatMap((s) => [['vpsm-traefik', instances[s]!.net] as [string, string], ['vpsm-worker', instances[s]!.net] as [string, string]]))

test('connects Traefik and the worker to the network of every live environment, once each', async () => {
  await goLive('web')
  await goLive('api') // same environment as web
  await goLive('site')

  expect(await ensureNetworkAttachments(deps)).toBe(2)

  expect(sorted(deps.docker.connections)).toEqual(expectedFor('web', 'site'))
  expect(deps.docker.aliasesOf('vpsm-traefik', instances.web!.net)).toEqual([])
  expect(deps.docker.aliasesOf('vpsm-worker', instances.site!.net)).toEqual([])
})

test('skips environments without a SUCCESS deployment', async () => {
  await goLive('web')
  const queued = await enqueueDeployment(db, { serviceInstanceId: instances.job!.id, trigger: 'manual' })
  await setDeploymentStatus(db, queued.id, 'BUILDING')
  await setDeploymentStatus(db, queued.id, 'FAILED', { failureReason: 'build failed' })
  const crashed = await enqueueDeployment(db, { serviceInstanceId: instances.site!.id, trigger: 'manual' })
  await setDeploymentStatus(db, crashed.id, 'BUILDING')
  await setDeploymentStatus(db, crashed.id, 'DEPLOYING', { imageTag: 'vpsm/site:x' })
  await markDeploymentLive(db, { deploymentId: crashed.id, containerName: 'vpsm-site-live' })
  await setDeploymentStatus(db, crashed.id, 'CRASHED', { failureReason: 'container exited with code 1' })

  expect(await ensureNetworkAttachments(deps)).toBe(1)

  expect(sorted(deps.docker.connections)).toEqual(expectedFor('web'))
})

test('does nothing when no deployment is live', async () => {
  expect(await ensureNetworkAttachments(deps)).toBe(0)
  expect(deps.docker.connections).toEqual([])
})

test('a failing network is logged and does not stop the others', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await goLive('web')
  await goLive('site')
  // Docker has no such network any more, so connecting fails.
  deps.docker.networks.delete(instances.web!.net)

  expect(await ensureNetworkAttachments(deps)).toBe(2)

  expect(sorted(deps.docker.connections)).toEqual(expectedFor('site'))
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(instances.web!.net))
})

test('keeps going when connecting the worker fails after Traefik succeeded', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await goLive('web')
  await goLive('site')
  const connect = deps.docker.connect.bind(deps.docker)
  vi.spyOn(deps.docker, 'connect').mockImplementation(async (container, net) => {
    if (container === 'vpsm-worker' && net === instances.web!.net) throw new Error('boom')
    await connect(container, net)
  })

  expect(await ensureNetworkAttachments(deps)).toBe(2)

  expect(sorted(deps.docker.connections)).toEqual(sorted([['vpsm-traefik', instances.web!.net], ...expectedFor('site')]))
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('boom'))
})
