import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createAppService,
  createProject,
  type Deployment,
  deployments,
  enqueueDeployment,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { reconcileLiveDeployments } from '../src/monitor/reconcile'
import type { ContainerState } from '../src/runtime/docker-runtime'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instances: Record<string, string>

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  instances = {}
  for (const serviceName of ['web', 'api']) {
    const { instance } = await createAppService(db, {
      projectName: 'shop',
      serviceName,
      source: { repo: `acme/${serviceName}`, branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    instances[serviceName] = instance.id
  }
  deps = fakeDeps(db)
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function get(d: { id: string }): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, d.id))
  return row!
}

/** A deployment of `service` that went live as container `vpsm-<service>-live`; that container runs unless `container: false`. */
async function live(service: string, o: { container?: boolean } = {}): Promise<Deployment> {
  const name = `vpsm-${service}-live`
  const d = await enqueueDeployment(db, { serviceInstanceId: instances[service]!, trigger: 'manual' })
  await setDeploymentStatus(db, d.id, 'BUILDING')
  await setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: `vpsm/${instances[service]}:${d.id}` })
  await markDeploymentLive(db, { deploymentId: d.id, containerName: name })
  if (o.container ?? true) {
    deps.docker.seedRunning([{ name, memoryMb: 512, deploymentId: d.id, serviceInstanceId: instances[service] }])
  }
  return get(d)
}

const stopped = (s: Partial<ContainerState> = {}): Partial<ContainerState> => ({
  running: false,
  restarting: false,
  exitCode: 137,
  restartCount: 0,
  ...s,
})
const gaveUp = stopped({ exitCode: 1, restartCount: 10, maxRetries: 10 })

test.each([true, false])('a live deployment whose container is gone becomes CRASHED (startStopped %s)', async (startStopped) => {
  const d = await live('web', { container: false })

  expect(await reconcileLiveDeployments(deps, { startStopped })).toEqual({ crashed: 1, started: 0 })

  const row = await get(d)
  expect(row.status).toBe('CRASHED')
  expect(row.failureReason).toBe('container disappeared')
})

test.each([true, false])('running and restarting containers are left alone (startStopped %s)', async (startStopped) => {
  const web = await live('web')
  const api = await live('api')
  deps.docker.setState('vpsm-api-live', { running: false, restarting: true, exitCode: 1, restartCount: 2 })

  expect(await reconcileLiveDeployments(deps, { startStopped })).toEqual({ crashed: 0, started: 0 })

  expect((await get(web)).status).toBe('SUCCESS')
  expect((await get(api)).status).toBe('SUCCESS')
  expect(deps.events).toEqual([])
})

test('with startStopped, a stopped live container is started again and stays SUCCESS', async () => {
  const d = await live('web')
  // Even one Docker has given up on: after a host reboot every container looks like this.
  deps.docker.setState('vpsm-web-live', gaveUp)

  expect(await reconcileLiveDeployments(deps, { startStopped: true })).toEqual({ crashed: 0, started: 1 })

  expect(deps.events).toEqual(['restart vpsm-web-live'])
  // Like `docker restart`: running again, and Docker's own restart counter is not bumped.
  expect(await deps.docker.state('vpsm-web-live')).toMatchObject({ running: true, restartCount: 10 })
  expect((await get(d)).status).toBe('SUCCESS')
})

test('a docker error on one container is logged and the other containers are still checked', async () => {
  await live('web')
  deps.docker.setState('vpsm-web-live', stopped())
  await live('api')
  deps.docker.setState('vpsm-api-live', stopped())
  // Whichever container is checked first fails, e.g. while Docker is removing it.
  const original = deps.docker.state.bind(deps.docker)
  let failed: string | undefined
  vi.spyOn(deps.docker, 'state').mockImplementation(async (name) => {
    if (failed === undefined) {
      failed = name
      throw new Error(`(HTTP code 409) unexpected - removal of container ${name} is already in progress`)
    }
    return original(name)
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await reconcileLiveDeployments(deps, { startStopped: true })).toEqual({ crashed: 0, started: 1 })

  const other = failed === 'vpsm-web-live' ? 'vpsm-api-live' : 'vpsm-web-live'
  expect(deps.events).toEqual([`restart ${other}`])
  expect(error).toHaveBeenCalledOnce()
  expect(error).toHaveBeenCalledWith(expect.stringContaining(`${failed}: (HTTP code 409)`))
})

test('a container whose deployment cannot be marked CRASHED does not stop the others', async () => {
  const web = await live('web', { container: false })
  const api = await live('api', { container: false })
  // Whichever is checked first: its row vanishes meanwhile, so marking it CRASHED throws (not found).
  const original = deps.docker.state.bind(deps.docker)
  let first: Deployment | undefined
  vi.spyOn(deps.docker, 'state').mockImplementation(async (name) => {
    if (first === undefined) {
      first = name === 'vpsm-web-live' ? web : api
      await db.delete(deployments).where(eq(deployments.id, first.id))
    }
    return original(name)
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await reconcileLiveDeployments(deps, { startStopped: false })).toEqual({ crashed: 1, started: 0 })

  const other = first === web ? api : web
  expect((await get(other)).status).toBe('CRASHED')
  expect(error).toHaveBeenCalledOnce()
})

test('with startStopped, a failed start marks the deployment CRASHED with the reason', async () => {
  const d = await live('web')
  deps.docker.setState('vpsm-web-live', stopped())
  vi.spyOn(deps.docker, 'restart').mockRejectedValue(new Error('no such image'))

  expect(await reconcileLiveDeployments(deps, { startStopped: true })).toEqual({ crashed: 1, started: 0 })

  const row = await get(d)
  expect(row.status).toBe('CRASHED')
  expect(row.failureReason).toBe('could not restart container: no such image')
})

test('without startStopped, a stopped container Docker gave up on becomes CRASHED; one it may restart is left', async () => {
  const web = await live('web')
  deps.docker.setState('vpsm-web-live', gaveUp)
  const api = await live('api')
  deps.docker.setState('vpsm-api-live', stopped({ exitCode: 1, restartCount: 3, maxRetries: 10 }))

  expect(await reconcileLiveDeployments(deps, { startStopped: false })).toEqual({ crashed: 1, started: 0 })

  expect((await get(web)).status).toBe('CRASHED')
  expect((await get(web)).failureReason).toBe('container exited with code 1')
  expect((await get(api)).status).toBe('SUCCESS')
  expect(deps.events).toEqual([])
})

test('only SUCCESS deployments are looked at', async () => {
  const replaced = await live('web')
  await setDeploymentStatus(db, replaced.id, 'REMOVED')
  deps.docker.setState('vpsm-web-live', stopped())
  const crashed = await live('api', { container: false })
  await setDeploymentStatus(db, crashed.id, 'CRASHED', { failureReason: 'container exited with code 1' })
  const state = vi.spyOn(deps.docker, 'state')

  expect(await reconcileLiveDeployments(deps, { startStopped: true })).toEqual({ crashed: 0, started: 0 })

  expect(state).not.toHaveBeenCalled()
  expect(deps.events).toEqual([])
  expect((await get(replaced)).status).toBe('REMOVED')
  expect((await get(crashed)).failureReason).toBe('container exited with code 1')
})

test('a deployment replaced while it was being checked is skipped', async () => {
  const d = await live('web', { container: false })
  const original = deps.docker.state.bind(deps.docker)
  vi.spyOn(deps.docker, 'state').mockImplementation(async (name) => {
    await setDeploymentStatus(db, d.id, 'REMOVED') // a newer deployment went live meanwhile
    return original(name)
  })

  expect(await reconcileLiveDeployments(deps, { startStopped: false })).toEqual({ crashed: 0, started: 0 })

  expect((await get(d)).status).toBe('REMOVED')
})
