import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  type Deployment,
  deployments,
  enqueueDeployment,
  markDeploymentLive,
  setDeploymentStatus,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { recoverInterruptedDeployments } from '../src/deploy/recovery'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instanceId: string

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  const { instance } = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  instanceId = instance.id
  deps = fakeDeps(db)
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

async function get(d: { id: string }): Promise<Deployment> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, d.id))
  return row!
}

const queue = () => enqueueDeployment(db, { serviceInstanceId: instanceId, trigger: 'manual' })

async function building(): Promise<Deployment> {
  const d = await queue()
  return setDeploymentStatus(db, d.id, 'BUILDING')
}

async function deploying(): Promise<Deployment> {
  const d = await building()
  return setDeploymentStatus(db, d.id, 'DEPLOYING', { imageTag: `vpsm/${instanceId}:${d.id}` })
}

async function live(containerName: string): Promise<Deployment> {
  const d = await deploying()
  await markDeploymentLive(db, { deploymentId: d.id, containerName })
  return get(d)
}

const seed = (name: string, deploymentId: string) =>
  deps.docker.seedRunning([{ name, memoryMb: 512, deploymentId, serviceInstanceId: instanceId }])

test('interrupted deployments become FAILED and orphans are removed, live one untouched', async () => {
  const liveOne = await live('vpsm-web-live0000')
  seed('vpsm-web-live0000', liveOne.id)
  const b1 = await building()
  const d1 = await deploying()
  seed('vpsm-web-d1000000', d1.id)
  const q1 = await queue()
  expect((await claimNextDeployment(db))?.id).toBe(q1.id)
  const q2 = await queue()
  const stopAndRemove = vi.spyOn(deps.docker, 'stopAndRemove')

  expect(await recoverInterruptedDeployments(deps)).toEqual({ failed: 3, removedContainers: 1 })

  for (const d of [b1, d1, q1]) {
    const row = await get(d)
    expect(row.status).toBe('FAILED')
    expect(row.failureReason).toBe('worker restarted during deployment')
    expect(row.finishedAt).not.toBeNull()
  }
  expect((await get(b1)).failureReason).toBe('worker restarted during deployment')
  expect((await get(q2)).status).toBe('QUEUED')
  expect((await get(liveOne)).status).toBe('SUCCESS')
  expect(deps.docker.has('vpsm-web-live0000')).toBe(true)
  expect(deps.docker.has('vpsm-web-d1000000')).toBe(false)
  expect(stopAndRemove).toHaveBeenCalledExactlyOnceWith('vpsm-web-d1000000', 0)
  expect(deps.events).toContain('routes')
})

test('keeps a CRASHED deployment container, removes containers of finished or unknown deployments', async () => {
  const crashed = await live('vpsm-web-crashed0')
  await setDeploymentStatus(db, crashed.id, 'CRASHED', { failureReason: 'container exited with code 1' })
  seed('vpsm-web-crashed0', crashed.id)
  const failed = await deploying()
  await setDeploymentStatus(db, failed.id, 'FAILED', { failureReason: 'healthcheck failed' })
  seed('vpsm-web-failed00', failed.id)
  // Left behind when a post-switch step failed: the row is REMOVED but its container still runs.
  const replaced = await live('vpsm-web-replaced')
  await setDeploymentStatus(db, replaced.id, 'REMOVED')
  seed('vpsm-web-replaced', replaced.id)
  seed('vpsm-web-gone0000', randomUUID()) // its row was deleted
  seed('vpsm-web-nolabel0', '')

  expect(await recoverInterruptedDeployments(deps)).toEqual({ failed: 0, removedContainers: 4 })

  expect((await deps.docker.listManaged()).map((c) => c.name)).toEqual(['vpsm-web-crashed0'])
  expect((await get(crashed)).status).toBe('CRASHED')
})

test('empties the work directory, including token-bearing clones left by a crash', async () => {
  const { workDir } = deps.config
  fs.mkdirSync(path.join(workDir, 'abc', 'src', '.git'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'abc', 'src', '.git', 'config'), 'url = https://x-access-token:secret@github.com/a/b\n')
  fs.writeFileSync(path.join(workDir, 'stray-file'), 'x')

  await recoverInterruptedDeployments(deps)

  expect(fs.existsSync(workDir)).toBe(true)
  expect(fs.readdirSync(workDir)).toEqual([])
})

test('a missing work directory is not an error', async () => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
  expect(await recoverInterruptedDeployments(deps)).toEqual({ failed: 0, removedContainers: 0 })
  expect(deps.events).toContain('routes')
})
