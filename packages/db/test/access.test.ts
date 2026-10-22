import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, test } from 'vitest'
import {
  type Actor,
  addMember,
  createAppService,
  createProject,
  findProjectFor,
  listMembers,
  listProjectsFor,
  projectMembers,
  projects,
  removeMember,
  users,
  ValidationError,
} from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
const { db } = t
beforeEach(() => t.reset())
afterAll(() => t.close())

// Rows are inserted directly: these tests are about access, not about hashing passwords.
async function makeUser(email: string, role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ email, name: email.split('@')[0]!, role, passwordHash: 'not-a-real-hash' })
    .returning()
  return { id: user!.id, role: user!.role }
}

const addService = (projectName: string, serviceName: string) =>
  createAppService(db, {
    projectName,
    serviceName,
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })

async function memberIds(projectId: string) {
  const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId))
  return rows.map((row) => row.userId).sort()
}

test('createProject with a creator makes them the first member', async () => {
  const alice = await makeUser('alice@example.com')
  const project = await createProject(db, 'shop', alice.id)
  expect(await memberIds(project.id)).toEqual([alice.id])
})

test('createProject without a creator still works and has no members', async () => {
  const project = await createProject(db, 'shop')
  expect(await memberIds(project.id)).toEqual([])
})

test('createProject with a creator that cannot be added creates nothing', async () => {
  await expect(createProject(db, 'shop', 'not-a-uuid')).rejects.toBeInstanceOf(ValidationError)
  await expect(createProject(db, 'shop', '00000000-0000-0000-0000-000000000000')).rejects.toThrow()
  expect(await db.select().from(projects)).toHaveLength(0)
})

test('members see only their projects; admins see all', async () => {
  const admin = await makeUser('root@example.com', 'admin')
  const alice = await makeUser('alice@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  const blog = await createProject(db, 'blog')
  await addService('shop', 'web')
  await addService('shop', 'api')

  expect(await listProjectsFor(db, alice)).toEqual([{ project: shop, serviceCount: 2 }])
  expect(await listProjectsFor(db, admin)).toEqual([
    { project: blog, serviceCount: 0 },
    { project: shop, serviceCount: 2 },
  ])
})

test('listProjectsFor sorts by name and counts each project once per member', async () => {
  const alice = await makeUser('alice@example.com')
  const bob = await makeUser('bob@example.com')
  for (const name of ['zoo', 'app', 'mid']) {
    const project = await createProject(db, name, alice.id)
    await addMember(db, project.id, 'bob@example.com')
  }
  await addService('mid', 'web')
  const rows = await listProjectsFor(db, bob)
  expect(rows.map((r) => [r.project.name, r.serviceCount])).toEqual([
    ['app', 0],
    ['mid', 1],
    ['zoo', 0],
  ])
})

test('findProjectFor returns null for an existing project the member is not in', async () => {
  const alice = await makeUser('alice@example.com')
  const outsider = await makeUser('carol@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  expect(await findProjectFor(db, outsider, 'shop')).toBeNull()
  expect(await findProjectFor(db, alice, 'shop')).toEqual(shop)
})

test('findProjectFor gives an admin any project and null for a missing one', async () => {
  const admin = await makeUser('root@example.com', 'admin')
  const shop = await createProject(db, 'shop')
  expect(await findProjectFor(db, admin, 'shop')).toEqual(shop)
  expect(await findProjectFor(db, admin, 'ghost')).toBeNull()
})

test('findProjectFor returns null, without querying badly, for names no project can have', async () => {
  const admin = await makeUser('root@example.com', 'admin')
  await createProject(db, 'shop')
  expect(await findProjectFor(db, admin, 'sh\u0000op')).toBeNull()
  expect(await findProjectFor(db, admin, 'Shop')).toBeNull()
  expect(await findProjectFor(db, { id: 'not-a-uuid', role: 'member' }, 'shop')).toBeNull()
})

test('listMembers returns id, email, name and when they were added, without other user columns', async () => {
  const alice = await makeUser('alice@example.com')
  await makeUser('bob@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  await addMember(db, shop.id, 'bob@example.com')

  const members = await listMembers(db, shop.id)
  expect(members.map((m) => m.user.email)).toEqual(['alice@example.com', 'bob@example.com'])
  expect(Object.keys(members[0]!.user).sort()).toEqual(['email', 'id', 'name'])
  expect(members[0]).toMatchObject({ user: { id: alice.id, name: 'alice' } })
  expect(members[0]!.addedAt).toBeInstanceOf(Date)
  expect(JSON.stringify(members)).not.toContain('not-a-real-hash')
})

test('addMember finds the user by normalised email and is idempotent', async () => {
  const alice = await makeUser('alice@example.com')
  const bob = await makeUser('bob@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  await addMember(db, shop.id, '  BOB@example.com ')
  await addMember(db, shop.id, 'bob@example.com')
  expect(await memberIds(shop.id)).toEqual([alice.id, bob.id].sort())
})

test('addMember refuses an unknown email', async () => {
  const shop = await createProject(db, 'shop')
  for (const email of ['ghost@example.com', 'gh\u0000ost@example.com']) {
    const error = await addMember(db, shop.id, email).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe('no user with that email')
  }
  expect(await memberIds(shop.id)).toEqual([])
})

test('removeMember removes a member', async () => {
  const alice = await makeUser('alice@example.com')
  const bob = await makeUser('bob@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  await addMember(db, shop.id, 'bob@example.com')
  await removeMember(db, shop.id, bob.id)
  expect(await memberIds(shop.id)).toEqual([alice.id])
})

test('cannot remove the last member', async () => {
  const alice = await makeUser('alice@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  const error = await removeMember(db, shop.id, alice.id).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as Error).message).toBe('a project needs at least one member')
  expect(await memberIds(shop.id)).toEqual([alice.id])
})

test('removing someone who is not a member changes nothing', async () => {
  const alice = await makeUser('alice@example.com')
  const bob = await makeUser('bob@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  await removeMember(db, shop.id, bob.id)
  await removeMember(db, shop.id, 'not-a-uuid')
  expect(await memberIds(shop.id)).toEqual([alice.id])
})

test('two members removing each other at the same time leave one member', async () => {
  const alice = await makeUser('alice@example.com')
  const bob = await makeUser('bob@example.com')
  const shop = await createProject(db, 'shop', alice.id)
  await addMember(db, shop.id, 'bob@example.com')

  const results = await Promise.allSettled([removeMember(db, shop.id, alice.id), removeMember(db, shop.id, bob.id)])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  expect(rejected!.reason).toBeInstanceOf(ValidationError)
  expect(await memberIds(shop.id)).toHaveLength(1)
})
