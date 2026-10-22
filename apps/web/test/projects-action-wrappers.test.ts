import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createProject, createUser, listMembers, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'

// The server action wrappers need Next's request scope (headers, the session cookie, the cache), which does not
// exist in a unit test: those are replaced here, and the rest (origin check, session guard, parsing, access
// rules, audit, redirect()/notFound(), the generic error) is the real code.
const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  origin: 'https://panel.example.com' as string | null,
  user: undefined as unknown,
  order: [] as string[],
  revalidatePath: vi.fn<(path: string) => void>(),
}))

vi.mock('next/headers', () => ({
  headers: async () => new Headers(mocks.origin === null ? {} : { origin: mocks.origin }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/server/config', () => ({ webConfig: () => ({ panelOrigin: 'https://panel.example.com' }) }))
vi.mock('@/server/db', () => ({ getDb: () => mocks.db }))
// The session lookup is the one thing under the real guards that is replaced: `order` shows whether it ran.
vi.mock('@/server/session', () => ({
  resolveSessionUser: async () => {
    mocks.order.push('session')
    return mocks.user
  },
}))

import {
  addMemberAction,
  createProjectAction,
  deleteProjectAction,
  removeMemberAction,
} from '@/server/actions/projects'
import { GENERIC_ERROR } from '@/server/errors'
import { ForbiddenError } from '@/server/origin'
import { nextErrorDigest, NOT_FOUND_DIGEST, PASSWORD, redirectTarget } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
  mocks.db = t.db
})
afterAll(async () => {
  await t?.close()
})

let ada: SafeUser
let bob: SafeUser
beforeEach(async () => {
  await t.reset()
  ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
  bob = await createUser(t.db, { email: 'bob@example.com', name: 'Bob', role: 'member', password: PASSWORD })
  mocks.user = ada
  mocks.origin = 'https://panel.example.com'
  mocks.order.length = 0
  mocks.revalidatePath.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}
const NO_STATE = {}

const projectNames = async () => (await t.sql`select name from projects order by name`).map((row) => row.name)
const auditActions = async () => (await t.sql`select action from audit_events order by id`).map((row) => row.action)

describe('every action starts with the same-origin check, then the session', () => {
  const attempts: [string, () => Promise<unknown>][] = [
    ['createProjectAction', () => createProjectAction(NO_STATE, form({ name: 'shop' }))],
    ['deleteProjectAction', () => deleteProjectAction('shop', NO_STATE, form({ confirm: 'shop' }))],
    ['addMemberAction', () => addMemberAction('shop', NO_STATE, form({ email: 'bob@example.com' }))],
    ['removeMemberAction', () => removeMemberAction('shop', bob.id, NO_STATE, form({}))],
  ]

  test.each(attempts)('%s refuses a missing, foreign or lookalike Origin before reading the session', async (_name, run) => {
    await createProject(t.db, 'shop', ada.id)
    for (const origin of [null, 'https://evil.example.com', 'https://panel.example.com/', 'http://panel.example.com', 'null']) {
      mocks.origin = origin
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError)
    }
    expect(mocks.order).toEqual([])
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test.each(attempts)('%s sends someone who is not signed in to /login and does nothing', async (_name, run) => {
    await createProject(t.db, 'shop', ada.id)
    mocks.user = null
    expect(redirectTarget(await nextErrorDigest(run))).toBe('/login')
    expect(mocks.order).toEqual(['session'])
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditActions()).toEqual([])
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('createProjectAction', () => {
  test('creates the project (the name is trimmed), refreshes the list and redirects to it', async () => {
    const digest = await nextErrorDigest(() => createProjectAction(NO_STATE, form({ name: '  shop  ' })))
    expect(redirectTarget(digest)).toBe('/projects/shop')
    expect(await projectNames()).toEqual(['shop'])
    expect((await listMembers(t.db, (await t.sql`select id from projects`)[0]!.id)).map((m) => m.user.id)).toEqual([ada.id])
    expect(await auditActions()).toEqual(['project.create'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/')
  })

  test('a bad name comes back as fieldErrors.name', async () => {
    const state = await createProjectAction(NO_STATE, form({ name: 'Not Valid' }))
    expect(state).toEqual({ fieldErrors: { name: expect.stringContaining('name must be') } })
    expect(await projectNames()).toEqual([])
  })

  test('a missing field, or a file where text belongs, counts as no name', async () => {
    expect(await createProjectAction(NO_STATE, form({}))).toEqual({ fieldErrors: { name: 'name is required' } })
    expect(await createProjectAction(NO_STATE, form({ name: new Blob(['shop']) }))).toEqual({
      fieldErrors: { name: 'name is required' },
    })
  })

  test('an unexpected failure is the generic message, logged without the statement parameters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table projects rename to projects_away`
    try {
      expect(await createProjectAction(NO_STATE, form({ name: 'shop' }))).toEqual({ error: GENERIC_ERROR })
    } finally {
      await t.sql`alter table projects_away rename to projects`
    }
    expect(GENERIC_ERROR).toBe('something went wrong')
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('creating project')
    expect(logged).not.toContain('params')
  })
})

describe('deleteProjectAction', () => {
  test('with the name typed it deletes, refreshes the list and goes back to it', async () => {
    await createProject(t.db, 'shop', ada.id)
    const digest = await nextErrorDigest(() => deleteProjectAction('shop', NO_STATE, form({ confirm: ' shop ' })))
    expect(redirectTarget(digest)).toBe('/')
    expect(await projectNames()).toEqual([])
    expect(await auditActions()).toEqual(['project.delete'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/')
  })

  test('with another name, or none, it stays and says to type the name', async () => {
    await createProject(t.db, 'shop', ada.id)
    const attempts: Record<string, string | Blob>[] = [{ confirm: 'shop2' }, {}, { confirm: new Blob(['shop']) }]
    for (const fields of attempts) {
      expect(await deleteProjectAction('shop', NO_STATE, form(fields))).toEqual({ error: 'type the project name to confirm' })
    }
    expect(await projectNames()).toEqual(['shop'])
  })

  test('someone outside the project gets the 404 page and the project stays', async () => {
    await createProject(t.db, 'shop', ada.id)
    mocks.user = bob
    expect(await nextErrorDigest(() => deleteProjectAction('shop', NO_STATE, form({ confirm: 'shop' })))).toBe(NOT_FOUND_DIGEST)
    expect(await nextErrorDigest(() => deleteProjectAction('nothing', NO_STATE, form({ confirm: 'nothing' })))).toBe(NOT_FOUND_DIGEST)
    expect(await projectNames()).toEqual(['shop'])
    expect(await auditActions()).toEqual([])
  })
})

describe('addMemberAction', () => {
  test('adds the member and refreshes the members page', async () => {
    const project = await createProject(t.db, 'shop', ada.id)
    expect(await addMemberAction('shop', NO_STATE, form({ email: ' Bob@example.com ' }))).toEqual({})
    expect((await listMembers(t.db, project.id)).map((m) => m.user.email)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(await auditActions()).toEqual(['member.add'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/members')
  })

  test('shows the validation message for an unknown email and refreshes nothing', async () => {
    await createProject(t.db, 'shop', ada.id)
    expect(await addMemberAction('shop', NO_STATE, form({ email: 'nobody@example.com' }))).toEqual({
      error: 'no user with that email',
    })
    expect(await addMemberAction('shop', NO_STATE, form({}))).toEqual({ fieldErrors: { email: 'email is required' } })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('someone outside the project gets the 404 page, whatever the email', async () => {
    await createProject(t.db, 'shop', ada.id)
    mocks.user = bob
    for (const email of ['bob@example.com', 'nobody@example.com']) {
      expect(await nextErrorDigest(() => addMemberAction('shop', NO_STATE, form({ email })))).toBe(NOT_FOUND_DIGEST)
    }
    expect(await auditActions()).toEqual([])
  })

  test('an unexpected failure is the generic message', async () => {
    await createProject(t.db, 'shop', ada.id)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table project_members rename to project_members_away`
    try {
      expect(await addMemberAction('shop', NO_STATE, form({ email: 'bob@example.com' }))).toEqual({ error: GENERIC_ERROR })
    } finally {
      await t.sql`alter table project_members_away rename to project_members`
    }
    expect(log).toHaveBeenCalled()
  })
})

describe('removeMemberAction', () => {
  test('removes the member and refreshes the members page', async () => {
    const project = await createProject(t.db, 'shop', ada.id)
    await addMemberAction('shop', NO_STATE, form({ email: 'bob@example.com' }))
    mocks.revalidatePath.mockReset()

    expect(await removeMemberAction('shop', bob.id, NO_STATE, form({}))).toEqual({})
    expect((await listMembers(t.db, project.id)).map((m) => m.user.email)).toEqual(['ada@example.com'])
    expect(await auditActions()).toEqual(['member.add', 'member.remove'])
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/projects/shop/members')
  })

  test('a member who removes themselves is sent to the project list, since the project is gone from their view', async () => {
    await createProject(t.db, 'shop', ada.id)
    await addMemberAction('shop', NO_STATE, form({ email: 'bob@example.com' }))
    mocks.user = bob
    const digest = await nextErrorDigest(() => removeMemberAction('shop', bob.id, NO_STATE, form({})))
    expect(redirectTarget(digest)).toBe('/')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/')
  })

  test('removing the last member shows the validation message', async () => {
    await createProject(t.db, 'shop', ada.id)
    expect(await removeMemberAction('shop', ada.id, NO_STATE, form({}))).toEqual({
      error: 'a project needs at least one member',
    })
  })

  test('someone outside the project gets the 404 page', async () => {
    await createProject(t.db, 'shop', ada.id)
    mocks.user = bob
    expect(await nextErrorDigest(() => removeMemberAction('shop', ada.id, NO_STATE, form({})))).toBe(NOT_FOUND_DIGEST)
  })
})
