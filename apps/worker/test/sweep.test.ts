import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { containerName, imageTag, networkName } from '@vpsm/core'
import {
  createAppService,
  createProject,
  deleteProject,
  deleteService,
  type Deployment,
  enqueueDeployment,
  markDeploymentLive,
  type ServiceInstance,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { sweepOrphans } from '../src/maintenance/sweep'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  deps = fakeDeps(db)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

async function service(projectName: string, serviceName: string): Promise<ServiceInstance> {
  const { instance } = await createAppService(db, {
    projectName,
    serviceName,
    source: { repo: `acme/${serviceName}`, branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  return instance
}

/** A deployment that went through the pipeline as far as DEPLOYING, with its image built. */
async function deploying(instance: ServiceInstance): Promise<Deployment> {
  const d = await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'BUILDING')
  const tag = imageTag(instance.id, d.id)
  deps.docker.existingImages.add(tag)
  return setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: tag })
}

/** A live deployment of `serviceName` with its running container, on its environment's network. */
async function live(instance: ServiceInstance, serviceName: string): Promise<{ deployment: Deployment; name: string }> {
  const deployment = await deploying(instance)
  const name = containerName(serviceName, deployment.id)
  await markDeploymentLive(db, { deploymentId: deployment.id, containerName: name })
  await deps.docker.ensureNetwork(networkName(instance.environmentId))
  deps.docker.seedRunning([{ name, memoryMb: 512, deploymentId: deployment.id, serviceInstanceId: instance.id }])
  await deps.docker.connect(deps.config.traefikContainer, networkName(instance.environmentId))
  return { deployment, name }
}

const containers = async () => (await deps.docker.listManaged()).map((c) => c.name).sort()
const images = () => [...deps.docker.existingImages].sort()
const networks = () => [...deps.docker.networks].sort()

test('removes containers, networks and images of a deleted service and rewrites routes', async () => {
  const shop = await createProject(db, 'shop')
  const web = await service('shop', 'web')
  const old = await deploying(web)
  await setDeploymentStatus(db, old.id, 'FAILED', { failureReason: 'healthcheck failed' })
  const webLive = await live(web, 'web')
  await createProject(db, 'blog')
  const site = await service('blog', 'site')
  const siteLive = await live(site, 'site')
  const kept = {
    containers: [siteLive.name],
    networks: [networkName(site.environmentId)],
    images: images().filter((i) => i.includes(site.id)),
  }

  // The service goes together with its project, so its environment (and network) goes too.
  await deleteProject(db, shop.id)

  expect(await sweepOrphans(deps)).toEqual({ containers: 1, networks: 1, images: 2 })

  expect(deps.events).toEqual([`stop ${webLive.name}`, `remove-network ${networkName(web.environmentId)}`, 'routes'])
  expect(await containers()).toEqual(kept.containers)
  expect(networks()).toEqual(kept.networks)
  expect(images()).toEqual(kept.images)
})

test('stops an orphaned container with a 10 second grace period', async () => {
  await createProject(db, 'shop')
  const web = await service('shop', 'web')
  const { name } = await live(web, 'web')
  await deleteService(db, web.id)
  const stopAndRemove = vi.spyOn(deps.docker, 'stopAndRemove')

  await sweepOrphans(deps)

  expect(stopAndRemove).toHaveBeenCalledExactlyOnceWith(name, 10)
})

test('deleting one service keeps the network of its environment', async () => {
  await createProject(db, 'shop')
  const web = await service('shop', 'web')
  const api = await service('shop', 'api')
  const webLive = await live(web, 'web')
  const apiLive = await live(api, 'api')
  const apiImages = images().filter((i) => i.includes(api.id))

  await deleteService(db, web.id)

  expect(await sweepOrphans(deps)).toEqual({ containers: 1, networks: 0, images: 1 })
  expect(deps.events).toEqual([`stop ${webLive.name}`, 'routes'])
  expect(await containers()).toEqual([apiLive.name])
  expect(networks()).toEqual([networkName(web.environmentId)])
  expect(images()).toEqual(apiImages)
})

test('never touches the live container of an existing service', async () => {
  await createProject(db, 'shop')
  const web = await service('shop', 'web')
  // Old images of an existing service are left to image retention, whatever their deployment's status.
  const failed = await deploying(web)
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'build failed' })
  const webLive = await live(web, 'web')
  const api = await service('shop', 'api')
  const apiCrashed = await live(api, 'api')
  await setDeploymentStatus(db, apiCrashed.deployment.id, 'CRASHED', { failureReason: 'container exited with code 1' })
  const before = { containers: await containers(), networks: networks(), images: images() }
  expect(before.containers).toEqual([apiCrashed.name, webLive.name].sort())
  expect(before.images).toHaveLength(3)

  expect(await sweepOrphans(deps)).toEqual({ containers: 0, networks: 0, images: 0 })

  expect(deps.events).toEqual(['routes'])
  expect(await containers()).toEqual(before.containers)
  expect(networks()).toEqual(before.networks)
  expect(images()).toEqual(before.images)
})

test('removes managed containers of finished, unknown or unlabelled deployments, like recovery', async () => {
  await createProject(db, 'shop')
  const web = await service('shop', 'web')
  const failed = await deploying(web)
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'healthcheck failed' })
  deps.docker.seedRunning([{ name: 'vpsm-web-failed00', memoryMb: 512, deploymentId: failed.id }])
  // Left behind when stopping it after a switch failed: the row is REMOVED but its container still runs.
  const replaced = await live(web, 'web')
  await setDeploymentStatus(db, replaced.deployment.id, 'REMOVED')
  deps.docker.seedRunning([
    { name: 'vpsm-web-gone0000', memoryMb: 512, deploymentId: randomUUID() },
    { name: 'vpsm-web-nolabel0', memoryMb: 512 },
  ])

  expect(await sweepOrphans(deps)).toEqual({ containers: 4, networks: 0, images: 0 })
  expect(await containers()).toEqual([])
})

test('ignores networks and images that are not named after an id', async () => {
  const notAnId = ['vpsm-env-not-a-uuid', 'vpsm-env-', `vpsm-env-${randomUUID()}-x`]
  for (const name of [...notAnId, 'bridge', 'vpsm-int-net']) await deps.docker.ensureNetwork(name)
  const tags = ['vpsm/not-a-uuid:1', `vpsm/${randomUUID()}-x:1`, `vpsm/${randomUUID()}`, 'alpine:3', `myvpsm/${randomUUID()}:1`]
  for (const tag of tags) deps.docker.existingImages.add(tag)

  expect(await sweepOrphans(deps)).toEqual({ containers: 0, networks: 0, images: 0 })

  expect(networks()).toEqual([...notAnId, 'bridge', 'vpsm-int-net'].sort())
  expect(images()).toEqual([...tags].sort())
  expect(deps.events).toEqual(['routes'])
})

test('one failing removal does not stop the rest', async () => {
  const orphans = ['vpsm-web-orphan01', 'vpsm-web-orphan02']
  deps.docker.seedRunning(orphans.map((name) => ({ name, memoryMb: 512, deploymentId: randomUUID() })))
  const [badNet, goodNet] = [networkName(randomUUID()), networkName(randomUUID())]
  for (const name of [badNet, goodNet]) await deps.docker.ensureNetwork(name)
  const [badImage, goodImage] = [imageTag(randomUUID(), randomUUID()), imageTag(randomUUID(), randomUUID())]
  for (const tag of [badImage, goodImage]) deps.docker.existingImages.add(tag)

  const docker = deps.docker
  const stopAndRemove = docker.stopAndRemove.bind(docker)
  vi.spyOn(docker, 'stopAndRemove').mockImplementation(async (name, timeoutSec) => {
    if (name === 'vpsm-web-orphan01') throw new Error('(HTTP code 409) removal of container vpsm-web-orphan01 is already in progress')
    return stopAndRemove(name, timeoutSec)
  })
  const removeNetwork = docker.removeNetwork.bind(docker)
  vi.spyOn(docker, 'removeNetwork').mockImplementation(async (name) => {
    if (name === badNet) throw new Error('(HTTP code 500) network has active endpoints')
    return removeNetwork(name)
  })
  const removeImage = docker.removeImage.bind(docker)
  vi.spyOn(docker, 'removeImage').mockImplementation(async (tag) => {
    if (tag === badImage) throw new Error('(HTTP code 500) daemon error')
    return removeImage(tag)
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await sweepOrphans(deps)).toEqual({ containers: 1, networks: 1, images: 1 })

  expect(await containers()).toEqual(['vpsm-web-orphan01'])
  expect(networks()).toEqual([badNet])
  expect(images()).toEqual([badImage])
  expect(deps.events.at(-1)).toBe('routes')
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    expect.stringContaining('vpsm-web-orphan01: (HTTP code 409)'),
    expect.stringContaining(`${badNet}: (HTTP code 500) network has active endpoints`),
    expect.stringContaining(`${badImage}: (HTTP code 500) daemon error`),
  ])
})

test('an image Docker keeps (e.g. still in use) is not counted as removed', async () => {
  const tag = imageTag(randomUUID(), randomUUID())
  deps.docker.existingImages.add(tag)
  // Like the real removeImage on a 409: no error, but the image stays.
  vi.spyOn(deps.docker, 'removeImage').mockImplementation(async () => {})

  expect(await sweepOrphans(deps)).toEqual({ containers: 0, networks: 0, images: 0 })
  expect(images()).toEqual([tag])
})

test('a failure to rewrite the routes is logged and the removals are still reported', async () => {
  deps.docker.seedRunning([{ name: 'vpsm-web-orphan01', memoryMb: 512, deploymentId: randomUUID() }])
  deps.regenerateRoutes = async () => {
    throw new Error('read-only file system')
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await sweepOrphans(deps)).toEqual({ containers: 1, networks: 0, images: 0 })
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('read-only file system'))
})
