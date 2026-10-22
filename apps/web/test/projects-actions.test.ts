import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  createUser,
  enqueueDeployment,
  listMembers,
  listProjectsFor,
  type Actor,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { NotFoundError } from '@/server/errors'
import { doAddMember, doCreateProject, doDeleteProject, doRemoveMember } from '@/server/projects'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
})

let ada: SafeUser
let bob: SafeUser
let cy: SafeUser
let root: SafeUser
const actorOf = (user: SafeUser): Actor => ({ id: user.id, role: user.role })

beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  ada = await make('ada@example.com', 'Ada', 'member')
  bob = await make('bob@example.com', 'Bob', 'member')
  cy = await make('cy@example.com', 'Cy', 'member')
  root = await make('root@example.com', 'Root', 'admin')
})

const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`
const projectNames = async () => (await t.sql`select name from projects order by name`).map((row) => row.name)
const memberEmails = async (projectId: string) => (await listMembers(t.db, projectId)).map((m) => m.user.email)

// A project created through the dashboard: `ada` is its only member.
async function adasProject(name = 'shop') {
  const result = await doCreateProject(t.db, actorOf(ada), { name })
  if (!('project' in result)) throw new Error(`could not create the project: ${JSON.stringify(result)}`)
  await t.sql`delete from audit_events`
  return result.project
}

describe('doCreateProject', () => {
  test('creates the project with the creator as its member and records project.create', async () => {
    const result = await doCreateProject(t.db, actorOf(ada), { name: 'shop' })
    if (!('project' in result)) throw new Error(`expected a project, got ${JSON.stringify(result)}`)
    expect(result.project.name).toBe('shop')

    expect(await memberEmails(result.project.id)).toEqual(['ada@example.com'])
    expect((await listProjectsFor(t.db, actorOf(ada))).map((p) => p.project.name)).toEqual(['shop'])
    expect(await listProjectsFor(t.db, actorOf(bob))).toEqual([])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'project.create',
        target_type: 'project',
        target_id: result.project.id,
        metadata: { name: 'shop' },
      },
    ])
  })

  test('an admin who creates a project becomes a member too', async () => {
    const result = await doCreateProject(t.db, actorOf(root), { name: 'ops' })
    if (!('project' in result)) throw new Error('expected a project')
    expect(await memberEmails(result.project.id)).toEqual(['root@example.com'])
  })

  test.each([
    ['uppercase', 'Shop'],
    ['a leading digit', '1shop'],
    ['a trailing hyphen', 'shop-'],
    ['a space inside', 'my shop'],
    ['too long', 'a'.repeat(31)],
    ['empty', ''],
    ['a path', '../etc'],
  ])('a name with %s gives fieldErrors.name and creates nothing', async (_why, name) => {
    const result = await doCreateProject(t.db, actorOf(ada), { name })
    expect(result).toEqual({ fieldErrors: { name: expect.stringMatching(/\S/) } })
    expect(await projectNames()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('no name at all is a fieldErrors.name too', async () => {
    expect(await doCreateProject(t.db, actorOf(ada), {})).toEqual({ fieldErrors: { name: 'name is required' } })
    expect(await projectNames()).toEqual([])
  })

  test('a name already taken (by anyone) is a fieldErrors.name and records nothing more', async () => {
    await adasProject('shop')
    const result = await doCreateProject(t.db, actorOf(bob), { name: 'shop' })
    expect(result).toEqual({ fieldErrors: { name: 'project "shop" already exists' } })
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditRows()).toEqual([])
  })

  test('an unexpected failure is not turned into a message here: it propagates for the generic mapping', async () => {
    await t.sql`alter table projects rename to projects_away`
    try {
      await expect(doCreateProject(t.db, actorOf(ada), { name: 'shop' })).rejects.toThrow()
    } finally {
      await t.sql`alter table projects_away rename to projects`
    }
    expect(await auditRows()).toEqual([])
  })

  test('failing to record the audit event is logged and the project stands', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      const result = await doCreateProject(t.db, actorOf(ada), { name: 'shop' })
      expect(result).toHaveProperty('project')
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(await projectNames()).toEqual(['shop'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('project.create')
  })
})

describe('doDeleteProject', () => {
  test('deletes the project when the name is typed to confirm (spaces around it are ignored) and records project.delete', async () => {
    const project = await adasProject('shop')
    expect(await doDeleteProject(t.db, actorOf(ada), 'shop', { confirm: '  shop ' })).toEqual({})
    expect(await projectNames()).toEqual([])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'project.delete',
        target_type: 'project',
        target_id: project.id,
        metadata: { name: 'shop' },
      },
    ])
  })

  test.each([
    ['nothing', undefined],
    ['an empty box', ''],
    ['only spaces', '   '],
    ['another name', 'shop2'],
    ['a different case', 'Shop'],
    ['part of the name', 'sho'],
    ['a name with extra text', 'shop please'],
  ])('with %s typed the project stays and the answer says to type the name', async (_what, confirm) => {
    await adasProject('shop')
    expect(await doDeleteProject(t.db, actorOf(ada), 'shop', { confirm })).toEqual({
      error: 'type the project name to confirm',
    })
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditRows()).toEqual([])
  })

  test('an outsider gets NotFound, with or without the right confirmation, and nothing is deleted', async () => {
    await adasProject('shop')
    await expect(doDeleteProject(t.db, actorOf(bob), 'shop', { confirm: 'shop' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(doDeleteProject(t.db, actorOf(bob), 'shop', { confirm: 'wrong' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditRows()).toEqual([])
  })

  test('a project that does not exist looks exactly like one the actor may not see', async () => {
    await adasProject('shop')
    const outsider = await doDeleteProject(t.db, actorOf(bob), 'shop', { confirm: 'shop' }).catch((e: unknown) => e)
    const missing = await doDeleteProject(t.db, actorOf(bob), 'nothing', { confirm: 'nothing' }).catch((e: unknown) => e)
    const malformed = await doDeleteProject(t.db, actorOf(bob), '../x', { confirm: '../x' }).catch((e: unknown) => e)
    for (const error of [outsider, missing, malformed]) expect(error).toBeInstanceOf(NotFoundError)
    expect((missing as Error).message).toBe((outsider as Error).message)
    expect((malformed as Error).message).toBe((outsider as Error).message)
  })

  test('an admin who is not a member can delete', async () => {
    await adasProject('shop')
    expect(await doDeleteProject(t.db, actorOf(root), 'shop', { confirm: 'shop' })).toEqual({})
    expect(await projectNames()).toEqual([])
    expect((await auditRows())[0]).toMatchObject({ actor_id: root.id, action: 'project.delete' })
  })

  test('a deployment that is running blocks the delete: its message is shown and nothing is recorded', async () => {
    await adasProject('shop')
    const { instance } = await createAppService(t.db, {
      projectName: 'shop',
      serviceName: 'web',
      source: { repo: 'acme/web', branch: 'main' },
      appsDomain: 'apps.example.com',
    })
    await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    await claimNextDeployment(t.db)

    expect(await doDeleteProject(t.db, actorOf(ada), 'shop', { confirm: 'shop' })).toEqual({
      error: 'wait for the running deployment to finish',
    })
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditRows()).toEqual([])
  })
})

describe('doAddMember', () => {
  test('adds the user with that email (case and spaces do not matter) and records member.add', async () => {
    const project = await adasProject('shop')
    expect(await doAddMember(t.db, actorOf(ada), 'shop', { email: '  BOB@Example.com ' })).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'member.add',
        target_type: 'project',
        target_id: project.id,
        metadata: { project: 'shop', email: 'bob@example.com' },
      },
    ])
    // The new member sees the project now.
    expect((await listProjectsFor(t.db, actorOf(bob))).map((p) => p.project.name)).toEqual(['shop'])
  })

  test('adding someone who is already a member changes nothing and records nothing', async () => {
    const project = await adasProject('shop')
    expect(await doAddMember(t.db, actorOf(ada), 'shop', { email: 'ada@example.com' })).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test('an email nobody has is shown as the validation message and records nothing', async () => {
    const project = await adasProject('shop')
    expect(await doAddMember(t.db, actorOf(ada), 'shop', { email: 'nobody@example.com' })).toEqual({
      error: 'no user with that email',
    })
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test.each([[undefined], [''], ['   ']])('an email of %j is a fieldErrors.email', async (email) => {
    await adasProject('shop')
    expect(await doAddMember(t.db, actorOf(ada), 'shop', { email })).toEqual({
      fieldErrors: { email: 'email is required' },
    })
    expect(await auditRows()).toEqual([])
  })

  test('an outsider gets NotFound before anything about the email is looked at', async () => {
    const project = await adasProject('shop')
    // Both a real colleague and a made-up address: the answer is the same, so nothing leaks.
    for (const email of ['cy@example.com', 'nobody@example.com', '']) {
      await expect(doAddMember(t.db, actorOf(bob), 'shop', { email })).rejects.toBeInstanceOf(NotFoundError)
    }
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test('a project that does not exist is NotFound too, and so is a malformed name', async () => {
    await expect(doAddMember(t.db, actorOf(ada), 'nothing', { email: 'bob@example.com' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(doAddMember(t.db, actorOf(ada), '../x', { email: 'bob@example.com' })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('an admin who is not a member can add members', async () => {
    const project = await adasProject('shop')
    expect(await doAddMember(t.db, actorOf(root), 'shop', { email: 'cy@example.com' })).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com', 'cy@example.com'])
    expect((await auditRows())[0]).toMatchObject({ actor_id: root.id, action: 'member.add' })
  })
})

describe('doRemoveMember', () => {
  async function shared() {
    const project = await adasProject('shop')
    await doAddMember(t.db, actorOf(ada), 'shop', { email: 'bob@example.com' })
    await t.sql`delete from audit_events`
    return project
  }

  test('removes the member and records member.remove with their email', async () => {
    const project = await shared()
    expect(await doRemoveMember(t.db, actorOf(ada), 'shop', bob.id)).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'member.remove',
        target_type: 'project',
        target_id: project.id,
        metadata: { project: 'shop', email: 'bob@example.com' },
      },
    ])
    expect(await listProjectsFor(t.db, actorOf(bob))).toEqual([])
  })

  test('a member who removes themselves is told they have left the project', async () => {
    const project = await shared()
    expect(await doRemoveMember(t.db, actorOf(bob), 'shop', bob.id)).toEqual({ leftProject: true })
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect((await auditRows())[0]).toMatchObject({ actor_id: bob.id, action: 'member.remove' })
  })

  test('an admin who removes themselves still sees every project, so they have not "left"', async () => {
    const project = await shared()
    await doAddMember(t.db, actorOf(root), 'shop', { email: 'root@example.com' })
    expect(await doRemoveMember(t.db, actorOf(root), 'shop', root.id)).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com', 'bob@example.com'])
  })

  test('the last member cannot be removed: the validation message is shown and nothing is recorded', async () => {
    const project = await adasProject('shop')
    expect(await doRemoveMember(t.db, actorOf(ada), 'shop', ada.id)).toEqual({
      error: 'a project needs at least one member',
    })
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test.each([
    ['a user who is not a member', () => cy.id],
    ['an id that is not a uuid', () => 'not-a-uuid'],
    ['an empty id', () => ''],
  ])('removing %s changes nothing and records nothing', async (_what, id) => {
    const project = await shared()
    expect(await doRemoveMember(t.db, actorOf(ada), 'shop', id())).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test('an outsider gets NotFound and removes nobody', async () => {
    const project = await shared()
    await expect(doRemoveMember(t.db, actorOf(cy), 'shop', bob.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(doRemoveMember(t.db, actorOf(cy), 'nothing', bob.id)).rejects.toBeInstanceOf(NotFoundError)
    expect(await memberEmails(project.id)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(await auditRows()).toEqual([])
  })

  test('an admin who is not a member can remove members', async () => {
    const project = await shared()
    expect(await doRemoveMember(t.db, actorOf(root), 'shop', bob.id)).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
  })
})

describe('a project made without a creator (the CLI) has no members', () => {
  test('a member cannot reach it, an admin can add the first member', async () => {
    const project = await createProject(t.db, 'ops')
    await expect(doAddMember(t.db, actorOf(ada), 'ops', { email: 'ada@example.com' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await doAddMember(t.db, actorOf(root), 'ops', { email: 'ada@example.com' })).toEqual({})
    expect(await memberEmails(project.id)).toEqual(['ada@example.com'])
  })
})
