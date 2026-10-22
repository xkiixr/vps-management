import { afterAll, beforeEach, expect, test } from 'vitest'
import {
  appendDeploymentLogs,
  createAppService,
  createProject,
  enqueueDeployment,
  findDeploymentInProject,
  listDeployments,
  type Project,
  readLogs,
  users,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
const { db } = t
afterAll(() => t.close())

let shop: Project
let webId: string
let apiId: string

const addService = async (projectName: string, serviceName: string) =>
  (
    await createAppService(db, {
      projectName,
      serviceName,
      source: { repo: 'acme/web', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
  ).instance.id

beforeEach(async () => {
  await t.reset()
  shop = await createProject(db, 'shop')
  webId = await addService('shop', 'web')
  apiId = await addService('shop', 'api')
})

const enqueue = (serviceInstanceId: string, createdById?: string) =>
  enqueueDeployment(db, { serviceInstanceId, trigger: 'manual', createdById })

test('listDeployments lists the service deployments newest first with who started them', async () => {
  const [alice] = await db
    .insert(users)
    .values({ email: 'alice@example.com', name: 'alice', role: 'member', passwordHash: 'secret-hash' })
    .returning()
  const first = await enqueue(webId)
  const second = await enqueue(webId, alice!.id)
  await enqueue(apiId)

  const rows = await listDeployments(db, webId)
  expect(rows.map((r) => [r.id, r.createdByEmail])).toEqual([
    [second.id, 'alice@example.com'],
    [first.id, null],
  ])
  expect(rows[0]).toMatchObject({ ...second, status: 'QUEUED' })
  expect(JSON.stringify(rows)).not.toContain('secret-hash')
})

test('listDeployments returns at most `limit` rows', async () => {
  for (let n = 0; n < 4; n++) await enqueue(webId)
  expect(await listDeployments(db, webId, 3)).toHaveLength(3)
  expect(await listDeployments(db, webId)).toHaveLength(4)
})

test('listDeployments of an id that is not a uuid is empty', async () => {
  expect(await listDeployments(db, 'not-a-uuid')).toEqual([])
})

test('findDeploymentInProject finds deployments of the project only', async () => {
  const d = await enqueue(webId)
  expect(await findDeploymentInProject(db, shop.id, d.id)).toEqual(d)

  const blog = await createProject(db, 'blog')
  const other = await enqueue(await addService('blog', 'docs'))
  expect(await findDeploymentInProject(db, shop.id, other.id)).toBeNull()
  expect(await findDeploymentInProject(db, blog.id, d.id)).toBeNull()
})

test('findDeploymentInProject returns null for unknown ids and ids that are not uuids', async () => {
  expect(await findDeploymentInProject(db, shop.id, '00000000-0000-0000-0000-000000000000')).toBeNull()
  expect(await findDeploymentInProject(db, shop.id, 'not-a-uuid')).toBeNull()
  expect(await findDeploymentInProject(db, shop.id, "x' or 1=1 --")).toBeNull()
})

test('readLogs pages by id', async () => {
  const d = await enqueue(webId)
  const other = await enqueue(apiId)
  await appendDeploymentLogs(db, d.id, 'build', ['a', 'b', 'c'])
  await appendDeploymentLogs(db, other.id, 'build', ['x'])
  await appendDeploymentLogs(db, d.id, 'deploy', ['d'])

  const all = await readLogs(db, d.id)
  expect(all.map((l) => [l.phase, l.line])).toEqual([
    ['build', 'a'],
    ['build', 'b'],
    ['build', 'c'],
    ['deploy', 'd'],
  ])
  expect(Object.keys(all[0]!).sort()).toEqual(['id', 'line', 'phase'])

  const page = await readLogs(db, d.id, all[0]!.id, 2)
  expect(page.map((l) => l.line)).toEqual(['b', 'c'])
  expect((await readLogs(db, d.id, page[1]!.id)).map((l) => l.line)).toEqual(['d'])
  expect(await readLogs(db, d.id, all[3]!.id)).toEqual([])
})

test('readLogs of a deployment id that is not a uuid is empty', async () => {
  expect(await readLogs(db, 'not-a-uuid')).toEqual([])
})

test('readLogs refuses a position or limit that is not a whole number', async () => {
  const d = await enqueue(webId)
  await expect(readLogs(db, d.id, Number.NaN)).rejects.toBeInstanceOf(ValidationError)
  await expect(readLogs(db, d.id, -1)).rejects.toBeInstanceOf(ValidationError)
  await expect(readLogs(db, d.id, 0, 1.5)).rejects.toBeInstanceOf(ValidationError)
})
