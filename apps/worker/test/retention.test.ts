import fs from 'node:fs'
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import type { DeploymentStatus } from '@vpsm/core'
import { createAppService, createProject, deployments } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { cleanupImages } from '../src/images/retention'
import { fakeDeps, type FakeDeps } from './fakes'

const t = await setupTestDb()
const { db } = t
let deps: FakeDeps
let instanceId: string
let otherInstanceId: string
let clock: number

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  const create = (serviceName: string) =>
    createAppService(db, {
      projectName: 'shop',
      serviceName,
      source: { repo: `acme/${serviceName}`, branch: 'main' },
      appsDomain: 'apps.example.com',
    })
  instanceId = (await create('web')).instance.id
  otherInstanceId = (await create('api')).instance.id
  deps = fakeDeps(db)
  clock = Date.parse('2026-10-01T00:00:00Z')
})
afterEach(() => {
  fs.rmSync(deps.config.workDir, { recursive: true, force: true })
})

/** Deployments of `instance`, one minute apart in the order given; each built (or reused) `tag`, whose image exists. */
async function history(list: { tag: string | null; status?: DeploymentStatus }[], instance = instanceId) {
  for (const { tag, status = 'REMOVED' } of list) {
    clock += 60_000
    await db.insert(deployments).values({
      serviceInstanceId: instance,
      trigger: 'manual',
      status,
      imageTag: tag,
      createdAt: new Date(clock),
    })
    if (tag) deps.docker.existingImages.add(tag)
  }
}

const tags = (...names: string[]) => names.map((n) => `vpsm/si:${n}`)

test('keeps newest 5 tags plus the live one', async () => {
  await history(
    tags('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8').map((tag) => ({
      tag,
      status: tag.endsWith('t2') ? 'SUCCESS' : 'REMOVED',
    })),
  )

  expect(await cleanupImages(deps, instanceId)).toEqual(tags('t1', 't3'))

  expect([...deps.docker.existingImages].sort()).toEqual(tags('t2', 't4', 't5', 't6', 't7', 't8'))
})

test('a rollback that reuses an old tag counts it once, as recent', async () => {
  await history([
    ...tags('t1', 't2', 't3', 't4', 't5', 't6').map((tag) => ({ tag })),
    { tag: 'vpsm/si:t1', status: 'SUCCESS' }, // rollback to t1
  ])

  expect(await cleanupImages(deps, instanceId)).toEqual(tags('t2'))
})

test('never removes the image of a CRASHED deployment, nor of other services', async () => {
  await history(tags('a1', 'a2').map((tag) => ({ tag })), otherInstanceId)
  await history([
    { tag: 'vpsm/si:t1', status: 'CRASHED' },
    { tag: null, status: 'FAILED' }, // failed before it built anything
    ...tags('t2', 't3', 't4', 't5', 't6', 't7').map((tag) => ({ tag, status: 'FAILED' as const })),
  ])

  expect(await cleanupImages(deps, instanceId)).toEqual(tags('t2'))

  expect(deps.docker.existingImages.has('vpsm/si:t1')).toBe(true)
  expect(deps.docker.existingImages.has('vpsm/si:a1')).toBe(true)
})

test('honours config.imageRetention and skips images that are already gone', async () => {
  deps.config.imageRetention = 2
  await history(tags('t1', 't2', 't3', 't4').map((tag) => ({ tag })))
  deps.docker.existingImages.delete('vpsm/si:t1')

  expect(await cleanupImages(deps, instanceId)).toEqual(tags('t2'))
  expect(await cleanupImages(deps, instanceId)).toEqual([])
})

test('does not report an image Docker kept because a container still uses it', async () => {
  await history(tags('t1', 't2', 't3', 't4', 't5', 't6').map((tag) => ({ tag })))
  // Docker refuses (409) and keeps it; removeImage swallows that.
  deps.docker.removeImage = async () => {}

  expect(await cleanupImages(deps, instanceId)).toEqual([])
})
