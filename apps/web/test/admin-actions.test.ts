import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  authenticate,
  createSession,
  createUser,
  getResourceSettings,
  resolveSession,
  setUserDisabled,
  type Actor,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import {
  doCreateUser,
  doResetPassword,
  doSaveResourceSettings,
  doSetDisabled,
  doSetRole,
  USER_NOT_FOUND,
} from '@/server/admin'
import { NotFoundError } from '@/server/errors'
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

let root: SafeUser
let other: SafeUser
let ada: SafeUser
const actorOf = (user: SafeUser): Actor => ({ id: user.id, role: user.role })

beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  root = await make('root@example.com', 'Root', 'admin')
  other = await make('other@example.com', 'Other', 'admin')
  ada = await make('ada@example.com', 'Ada', 'member')
})

const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`
const userRow = async (id: string) => (await t.sql`select role, disabled_at from users where id = ${id}`)[0]!
const sessionCount = async (userId: string) =>
  Number((await t.sql`select count(*) as n from sessions where user_id = ${userId}`)[0]!.n)

describe('doCreateUser', () => {
  test('creates the user with a generated password, returns it once and records user.create without it', async () => {
    const result = await doCreateUser(t.db, actorOf(root), { email: '  Bob@Example.com ', name: ' Bob ', role: 'member' })
    if (!result.issued) throw new Error(`expected a password, got ${JSON.stringify(result)}`)
    expect(result.issued.email).toBe('bob@example.com')
    expect(result.issued.password).toMatch(/^[A-Za-z0-9]{20}$/)

    const bob = await authenticate(t.db, 'bob@example.com', result.issued.password)
    expect(bob).toMatchObject({ email: 'bob@example.com', name: 'Bob', role: 'member', disabledAt: null })
    expect(await auditRows()).toEqual([
      {
        actor_id: root.id,
        action: 'user.create',
        target_type: 'user',
        target_id: bob!.id,
        metadata: { email: 'bob@example.com', role: 'member' },
      },
    ])
    expect(JSON.stringify(await auditRows())).not.toContain(result.issued.password)
  })

  test('the role is member unless admin is chosen', async () => {
    const byDefault = await doCreateUser(t.db, actorOf(root), { email: 'a@example.com', name: 'A' })
    const empty = await doCreateUser(t.db, actorOf(root), { email: 'b@example.com', name: 'B', role: '' })
    const admin = await doCreateUser(t.db, actorOf(root), { email: 'c@example.com', name: 'C', role: 'admin' })
    expect(byDefault.issued).toBeDefined()
    expect(empty.issued).toBeDefined()
    expect(admin.issued).toBeDefined()
    expect((await t.sql`select email, role from users where email in ('a@example.com', 'b@example.com', 'c@example.com') order by email`)).toMatchObject([
      { role: 'member' },
      { role: 'member' },
      { role: 'admin' },
    ])
    expect((await auditRows()).map((row) => row.metadata)).toEqual([
      { email: 'a@example.com', role: 'member' },
      { email: 'b@example.com', role: 'member' },
      { email: 'c@example.com', role: 'admin' },
    ])
  })

  test.each<[string, Record<string, string | undefined>, Record<string, string>]>([
    ['no email', { name: 'Bob' }, { email: 'email is required' }],
    ['a blank email', { email: '  ', name: 'Bob' }, { email: 'email is required' }],
    ['no name', { email: 'bob@example.com' }, { name: 'name is required' }],
    ['a blank name', { email: 'bob@example.com', name: '   ' }, { name: 'name is required' }],
    ['an email that is not one', { email: 'bob', name: 'Bob' }, { email: 'invalid email address "bob"' }],
    ['an email with a control character', { email: 'bob@exa\nmple.com', name: 'Bob' }, { email: 'email contains invalid characters' }],
    ['a name with a control character', { email: 'bob@example.com', name: 'Bo\u0000b' }, { name: 'name contains invalid characters' }],
    ['an email already taken', { email: 'ADA@example.com', name: 'Another Ada' }, { email: 'a user with this email already exists' }],
    ['an unknown role', { email: 'bob@example.com', name: 'Bob', role: 'owner' }, { role: 'role must be "admin" or "member"' }],
  ])('%s is refused next to the field and nothing is created', async (_what, input, fieldErrors) => {
    expect(await doCreateUser(t.db, actorOf(root), input)).toEqual({ fieldErrors })
    expect(await t.sql`select 1 from users`).toHaveLength(3)
    expect(await auditRows()).toEqual([])
  })

  test('reports every field that is wrong at once', async () => {
    expect(await doCreateUser(t.db, actorOf(root), { role: 'owner' })).toEqual({
      fieldErrors: { email: 'email is required', name: 'name is required', role: 'role must be "admin" or "member"' },
    })
  })

  test('anyone who is not an admin gets NotFoundError and nothing is created', async () => {
    await expect(doCreateUser(t.db, actorOf(ada), { email: 'bob@example.com', name: 'Bob' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await t.sql`select 1 from users`).toHaveLength(3)
    expect(await auditRows()).toEqual([])
  })

  test('a failure to record the event does not take the password away from the admin', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    let result: Awaited<ReturnType<typeof doCreateUser>>
    try {
      result = await doCreateUser(t.db, actorOf(root), { email: 'bob@example.com', name: 'Bob' })
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(result.issued).toBeDefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).not.toContain(result.issued!.password)
  })
})

describe('doResetPassword', () => {
  test('sets a new generated password, ends the user sessions and records user.reset_password without it', async () => {
    const { token } = await createSession(t.db, ada.id)
    const rootSession = await createSession(t.db, root.id)

    const result = await doResetPassword(t.db, actorOf(root), ada.id)
    if (!result.issued) throw new Error(`expected a password, got ${JSON.stringify(result)}`)
    expect(result.issued.email).toBe('ada@example.com')
    expect(result.issued.password).toMatch(/^[A-Za-z0-9]{20}$/)

    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', result.issued.password)).toMatchObject({ id: ada.id })
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(await resolveSession(t.db, rootSession.token)).not.toBeNull()
    expect(result.ownPassword).toBeUndefined()
    expect(await auditRows()).toEqual([
      { actor_id: root.id, action: 'user.reset_password', target_type: 'user', target_id: ada.id, metadata: { email: 'ada@example.com' } },
    ])
    expect(JSON.stringify(await auditRows())).not.toContain(result.issued.password)
  })

  test('an admin may reset their own password; their own sessions end and the result says so', async () => {
    const { token } = await createSession(t.db, root.id)
    const result = await doResetPassword(t.db, actorOf(root), root.id)
    expect(result).toMatchObject({ ownPassword: true, issued: { email: 'root@example.com' } })
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(await sessionCount(root.id)).toBe(0)
    expect((await auditRows()).map((row) => row.action)).toEqual(['user.reset_password'])
  })

  test.each([
    ['an id nobody has', '00000000-0000-4000-8000-000000000000'],
    ['something that is not an id', 'not-a-uuid'],
    ['an empty id', ''],
    ["an id that tries SQL", "x'; drop table users; --"],
    ['an id that is not text', 42 as unknown as string],
  ])('%s is "user not found" and nothing happens', async (_what, id) => {
    expect(await doResetPassword(t.db, actorOf(root), id)).toEqual({ error: USER_NOT_FOUND })
    expect(USER_NOT_FOUND).toBe('user not found')
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()
    expect(await auditRows()).toEqual([])
  })

  test('anyone who is not an admin gets NotFoundError and nothing changes', async () => {
    await expect(doResetPassword(t.db, actorOf(ada), root.id)).rejects.toBeInstanceOf(NotFoundError)
    expect(await authenticate(t.db, 'root@example.com', PASSWORD)).not.toBeNull()
    expect(await auditRows()).toEqual([])
  })
})

describe('doSetRole', () => {
  test('promotes a member and records user.set_role', async () => {
    expect(await doSetRole(t.db, actorOf(root), ada.id, 'admin')).toEqual({})
    expect((await userRow(ada.id)).role).toBe('admin')
    expect(await auditRows()).toEqual([
      { actor_id: root.id, action: 'user.set_role', target_type: 'user', target_id: ada.id, metadata: { email: 'ada@example.com', role: 'admin' } },
    ])
  })

  test('demotes another admin', async () => {
    expect(await doSetRole(t.db, actorOf(root), other.id, 'member')).toEqual({})
    expect((await userRow(other.id)).role).toBe('member')
  })

  test('an admin may demote themselves while another active admin remains, and the result says so', async () => {
    expect(await doSetRole(t.db, actorOf(root), root.id, 'member')).toEqual({ demotedSelf: true })
    expect((await userRow(root.id)).role).toBe('member')
    expect((await auditRows()).map((row) => row.action)).toEqual(['user.set_role'])
  })

  test('the last active admin cannot be demoted, with the message of the database rule', async () => {
    await doSetRole(t.db, actorOf(root), other.id, 'member')
    await t.sql`delete from audit_events`
    expect(await doSetRole(t.db, actorOf(root), root.id, 'member')).toEqual({ error: 'at least one active admin is required' })
    expect((await userRow(root.id)).role).toBe('admin')
    expect(await auditRows()).toEqual([])
  })

  test('a disabled admin does not count as the other active admin', async () => {
    await setUserDisabled(t.db, other.id, true)
    expect(await doSetRole(t.db, actorOf(root), root.id, 'member')).toEqual({ error: 'at least one active admin is required' })
    expect((await userRow(root.id)).role).toBe('admin')
  })

  test('a role the user already has is not a change and not an event', async () => {
    expect(await doSetRole(t.db, actorOf(root), ada.id, 'member')).toEqual({})
    expect(await doSetRole(t.db, actorOf(root), root.id, 'admin')).toEqual({})
    expect(await auditRows()).toEqual([])
  })

  test.each([['owner'], [''], ['ADMIN'], [42 as unknown as string], [undefined as unknown as string]])(
    'the role %j is refused',
    async (role) => {
      expect(await doSetRole(t.db, actorOf(root), ada.id, role)).toEqual({ error: 'role must be "admin" or "member"' })
      expect((await userRow(ada.id)).role).toBe('member')
      expect(await auditRows()).toEqual([])
    },
  )

  test.each([['00000000-0000-4000-8000-000000000000'], ['nope'], [7 as unknown as string]])(
    'user %j is "user not found"',
    async (id) => {
      expect(await doSetRole(t.db, actorOf(root), id, 'admin')).toEqual({ error: USER_NOT_FOUND })
      expect(await auditRows()).toEqual([])
    },
  )

  test('anyone who is not an admin gets NotFoundError, even for themselves', async () => {
    await expect(doSetRole(t.db, actorOf(ada), ada.id, 'admin')).rejects.toBeInstanceOf(NotFoundError)
    expect((await userRow(ada.id)).role).toBe('member')
    expect(await auditRows()).toEqual([])
  })
})

describe('doSetDisabled', () => {
  test('disables a user, ends their sessions and records user.disable; enabling records user.enable', async () => {
    const { token } = await createSession(t.db, ada.id)
    expect(await doSetDisabled(t.db, actorOf(root), ada.id, true)).toEqual({})
    expect((await userRow(ada.id)).disabled_at).not.toBeNull()
    expect(await resolveSession(t.db, token)).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).toBeNull()

    expect(await doSetDisabled(t.db, actorOf(root), ada.id, false)).toEqual({})
    expect((await userRow(ada.id)).disabled_at).toBeNull()
    expect(await authenticate(t.db, 'ada@example.com', PASSWORD)).not.toBeNull()

    expect(await auditRows()).toEqual([
      { actor_id: root.id, action: 'user.disable', target_type: 'user', target_id: ada.id, metadata: { email: 'ada@example.com' } },
      { actor_id: root.id, action: 'user.enable', target_type: 'user', target_id: ada.id, metadata: { email: 'ada@example.com' } },
    ])
  })

  test('an admin may disable themselves while another active admin remains, and the result says so', async () => {
    const { token } = await createSession(t.db, root.id)
    expect(await doSetDisabled(t.db, actorOf(root), root.id, true)).toEqual({ disabledSelf: true })
    expect((await userRow(root.id)).disabled_at).not.toBeNull()
    expect(await resolveSession(t.db, token)).toBeNull()
  })

  test('the last active admin cannot be disabled, with the message of the database rule', async () => {
    await setUserDisabled(t.db, other.id, true)
    const { token } = await createSession(t.db, root.id)
    expect(await doSetDisabled(t.db, actorOf(root), root.id, true)).toEqual({ error: 'at least one active admin is required' })
    expect((await userRow(root.id)).disabled_at).toBeNull()
    expect(await resolveSession(t.db, token)).not.toBeNull()
    expect(await auditRows()).toEqual([])
  })

  test('a state the user is already in is not a change and not an event', async () => {
    expect(await doSetDisabled(t.db, actorOf(root), ada.id, false)).toEqual({})
    await doSetDisabled(t.db, actorOf(root), ada.id, true)
    const before = await userRow(ada.id)
    expect(await doSetDisabled(t.db, actorOf(root), ada.id, true)).toEqual({})
    expect(await userRow(ada.id)).toEqual(before)
    expect((await auditRows()).map((row) => row.action)).toEqual(['user.disable'])
  })

  test.each([['yes'], [1], [undefined], [null]])('%j is not true or false and is refused', async (disabled) => {
    expect(await doSetDisabled(t.db, actorOf(root), ada.id, disabled as unknown as boolean)).toEqual({
      error: 'disabled must be true or false',
    })
    expect((await userRow(ada.id)).disabled_at).toBeNull()
  })

  test.each([['00000000-0000-4000-8000-000000000000'], ['nope'], [{}]])('user %j is "user not found"', async (id) => {
    expect(await doSetDisabled(t.db, actorOf(root), id as unknown as string, true)).toEqual({ error: USER_NOT_FOUND })
    expect(await auditRows()).toEqual([])
  })

  test('anyone who is not an admin gets NotFoundError and nothing changes', async () => {
    await expect(doSetDisabled(t.db, actorOf(ada), root.id, true)).rejects.toBeInstanceOf(NotFoundError)
    expect((await userRow(root.id)).disabled_at).toBeNull()
    expect(await auditRows()).toEqual([])
  })
})

describe('doSaveResourceSettings', () => {
  test('saves both values, records settings.update with them and reads back what was saved', async () => {
    expect(await doSaveResourceSettings(t.db, actorOf(root), { memoryBudgetMb: ' 6144 ', maxServiceMemoryMb: '0512' })).toEqual({
      notice: 'Settings saved. They apply to the next deployment.',
    })
    expect(await getResourceSettings(t.db)).toEqual({ memoryBudgetMb: 6144, maxServiceMemoryMb: 512 })
    expect(await auditRows()).toEqual([
      {
        actor_id: root.id,
        action: 'settings.update',
        target_type: 'settings',
        target_id: null,
        metadata: { memoryBudgetMb: 6144, maxServiceMemoryMb: 512 },
      },
    ])
    expect((await t.sql`select updated_by from settings`).map((row) => row.updated_by)).toEqual([root.id, root.id])
  })

  test.each([
    ['nothing', ''],
    ['spaces', '   '],
    ['letters', 'lots'],
    ['a unit', '512MB'],
    ['a fraction', '512.5'],
    ['a minus sign', '-512'],
    ['a plus sign', '+512'],
    ['an exponent', '1e3'],
    ['hex', '0x200'],
    ['digits of another script', '٥١٢'],
    ['a thousands separator', '1,024'],
  ])('%s is not a whole number; it is shown next to the field and nothing is saved', async (_what, typed) => {
    expect(await doSaveResourceSettings(t.db, actorOf(root), { memoryBudgetMb: typed, maxServiceMemoryMb: '512' })).toEqual({
      fieldErrors: { memoryBudgetMb: 'must be a whole number' },
    })
    expect(await doSaveResourceSettings(t.db, actorOf(root), { memoryBudgetMb: '4096', maxServiceMemoryMb: typed })).toEqual({
      fieldErrors: { maxServiceMemoryMb: 'must be a whole number' },
    })
    expect(await getResourceSettings(t.db)).toEqual({})
    expect(await auditRows()).toEqual([])
  })

  test('a missing field counts as not a whole number, and both can be wrong at once', async () => {
    expect(await doSaveResourceSettings(t.db, actorOf(root), {})).toEqual({
      fieldErrors: { memoryBudgetMb: 'must be a whole number', maxServiceMemoryMb: 'must be a whole number' },
    })
  })

  test.each([
    ['a budget of 0', { memoryBudgetMb: '0', maxServiceMemoryMb: '512' }, 'memory budget must be a positive whole number of MB'],
    ['a budget too big for a number', { memoryBudgetMb: '9'.repeat(30), maxServiceMemoryMb: '512' }, 'memory budget must be a positive whole number of MB'],
    ['a max of 0', { memoryBudgetMb: '4096', maxServiceMemoryMb: '0' }, 'max memory per service must be a positive whole number of at least 6 MB'],
    ['a max under 6', { memoryBudgetMb: '4096', maxServiceMemoryMb: '5' }, 'max memory per service must be a positive whole number of at least 6 MB'],
    ['a max over the budget', { memoryBudgetMb: '1024', maxServiceMemoryMb: '2048' }, 'max memory per service cannot be more than the memory budget'],
  ])('%s shows the message of the database check as it is, and nothing is saved', async (_what, input, message) => {
    expect(await doSaveResourceSettings(t.db, actorOf(root), input)).toEqual({ error: message })
    expect(await getResourceSettings(t.db)).toEqual({})
    expect(await auditRows()).toEqual([])
  })

  test('a refused save leaves what was saved before untouched', async () => {
    await doSaveResourceSettings(t.db, actorOf(root), { memoryBudgetMb: '4096', maxServiceMemoryMb: '1024' })
    await t.sql`delete from audit_events`
    expect(await doSaveResourceSettings(t.db, actorOf(root), { memoryBudgetMb: '100', maxServiceMemoryMb: '1024' })).toEqual({
      error: 'max memory per service cannot be more than the memory budget',
    })
    expect(await getResourceSettings(t.db)).toEqual({ memoryBudgetMb: 4096, maxServiceMemoryMb: 1024 })
    expect(await auditRows()).toEqual([])
  })

  test('anyone who is not an admin gets NotFoundError and nothing is saved', async () => {
    await expect(
      doSaveResourceSettings(t.db, actorOf(ada), { memoryBudgetMb: '4096', maxServiceMemoryMb: '1024' }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(await getResourceSettings(t.db)).toEqual({})
    expect(await auditRows()).toEqual([])
  })
})
