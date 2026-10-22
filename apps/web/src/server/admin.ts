import {
  type Actor,
  createUser,
  type Db,
  generatePassword,
  listUsers,
  type SafeUser,
  setPassword,
  setResourceSettings,
  setUserDisabled,
  setUserRole,
  ValidationError,
} from '@vpsm/db'
import type { ActionState, FieldErrors, PasswordState } from './action-state'
import { auditBestEffort } from './audit'
import { NotFoundError } from './errors'
import { refusal } from './projects'

// The logic of the admin actions (users and system settings), apart from Next (headers, session, redirects), so
// that it can be tested against a database; see ./projects.ts for how this is split from the actions.
//
// The actions start with beginAdminAction(), which already turns a member away with a 404, and each function here
// checks it again: what these functions do is not something to leave to the caller having remembered. A user id
// comes from the browser (it is bound to an action by the page), so it is looked up before anything is done with
// it. Admins can see every user, so an unknown id is an ordinary message and not a 404.
//
// A generated password is part of the result and nothing else: it is not logged or audited, and the audit events
// record who and what, never the secret.

export const USER_NOT_FOUND = 'user not found'
export const ROLE_MESSAGE = 'role must be "admin" or "member"'
export const DISABLED_MESSAGE = 'disabled must be true or false'
export const SETTINGS_SAVED_NOTICE = 'Settings saved. They apply to the next deployment.'

const NOT_A_WHOLE_NUMBER = 'must be a whole number'

export const CREATE_USER_FIELDS = ['email', 'name', 'role'] as const
export const SETTINGS_FIELDS = ['memoryBudgetMb', 'maxServiceMemoryMb'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Defence in depth behind beginAdminAction(): the same 404 a member gets everywhere else.
function assertAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new NotFoundError()
}

const isRole = (role: unknown): role is 'admin' | 'member' => role === 'admin' || role === 'member'

// The id of a bound action argument comes from the browser and is not guaranteed to be text, let alone a uuid
// (Postgres refuses a comparison with something that is not one).
async function findUser(db: Db, userId: string): Promise<SafeUser | null> {
  if (typeof userId !== 'string' || !UUID.test(userId)) return null
  const id = userId.toLowerCase()
  return (await listUsers(db)).find((user) => user.id === id) ?? null
}

// What createUser refuses is about one of the three fields; its message says which.
function createUserProblem(message: string): ActionState {
  if (/\bemail\b/.test(message)) return { fieldErrors: { email: message } }
  if (/^name\b/.test(message)) return { fieldErrors: { name: message } }
  if (/^role\b/.test(message)) return { fieldErrors: { role: message } }
  return { error: message }
}

export type CreateUserInput = Partial<Record<(typeof CREATE_USER_FIELDS)[number], string>>

/**
 * Creates an account with a generated password and records user.create (email and role only). The password is
 * returned in `issued` for the admin to pass on; it is the only place it ever exists in clear. The role is
 * `member` unless `admin` is chosen.
 */
export async function doCreateUser(db: Db, actor: Actor, input: CreateUserInput): Promise<PasswordState> {
  assertAdmin(actor)
  const email = (input.email ?? '').trim()
  const name = (input.name ?? '').trim()
  const role = (input.role ?? '').trim() || 'member'

  const fieldErrors: FieldErrors = {}
  if (email === '') fieldErrors.email = 'email is required'
  if (name === '') fieldErrors.name = 'name is required'
  if (!isRole(role)) fieldErrors.role = ROLE_MESSAGE
  if (Object.keys(fieldErrors).length > 0 || !isRole(role)) return { fieldErrors }

  const password = generatePassword()
  let user: SafeUser
  try {
    user = await createUser(db, { email, name, role, password })
  } catch (error) {
    if (error instanceof ValidationError) return createUserProblem(error.message)
    throw error
  }
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'user.create',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: user.email, role: user.role },
  })
  return { issued: { email: user.email, password } }
}

export type ResetPasswordResult = PasswordState & {
  /** The admin reset their own password, which ended their own sessions too: they must sign in again. */
  ownPassword?: true
}

/** Gives the user a new generated password (every session of theirs ends) and records user.reset_password. */
export async function doResetPassword(db: Db, actor: Actor, userId: string): Promise<ResetPasswordResult> {
  assertAdmin(actor)
  const target = await findUser(db, userId)
  if (!target) return { error: USER_NOT_FOUND }

  const password = generatePassword()
  const failed = await refusal(() => setPassword(db, target.id, password))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'user.reset_password',
    targetType: 'user',
    targetId: target.id,
    metadata: { email: target.email },
  })
  return { issued: { email: target.email, password }, ...(target.id === actor.id ? { ownPassword: true as const } : {}) }
}

export type SetRoleResult = ActionState & {
  /** The admin made themselves a member: the admin pages are no longer theirs. */
  demotedSelf?: true
}

/**
 * Changes the user's role and records user.set_role. The last active admin cannot be demoted (the database
 * refuses, and its message is the answer). A role the user already has is not a change and not an event.
 */
export async function doSetRole(db: Db, actor: Actor, userId: string, role: string): Promise<SetRoleResult> {
  assertAdmin(actor)
  if (!isRole(role)) return { error: ROLE_MESSAGE }
  const target = await findUser(db, userId)
  if (!target) return { error: USER_NOT_FOUND }
  if (target.role === role) return {}

  const failed = await refusal(() => setUserRole(db, target.id, role))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'user.set_role',
    targetType: 'user',
    targetId: target.id,
    metadata: { email: target.email, role },
  })
  return target.id === actor.id && role === 'member' ? { demotedSelf: true } : {}
}

export type SetDisabledResult = ActionState & {
  /** The admin disabled their own account, which ended their sessions: they are signed out. */
  disabledSelf?: true
}

/**
 * Disables (which ends the user's sessions) or enables the user and records user.disable / user.enable. The last
 * active admin cannot be disabled (the database refuses, and its message is the answer). A state the user is
 * already in is not a change and not an event.
 */
export async function doSetDisabled(db: Db, actor: Actor, userId: string, disabled: boolean): Promise<SetDisabledResult> {
  assertAdmin(actor)
  if (typeof disabled !== 'boolean') return { error: DISABLED_MESSAGE }
  const target = await findUser(db, userId)
  if (!target) return { error: USER_NOT_FOUND }
  if ((target.disabledAt !== null) === disabled) return {}

  const failed = await refusal(() => setUserDisabled(db, target.id, disabled))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: disabled ? 'user.disable' : 'user.enable',
    targetType: 'user',
    targetId: target.id,
    metadata: { email: target.email },
  })
  return target.id === actor.id && disabled ? { disabledSelf: true } : {}
}

export type SettingsInput = Partial<Record<(typeof SETTINGS_FIELDS)[number], string>>

// A number typed into a form: digits only, so no sign, fraction, exponent, unit or other script's digits.
function wholeNumber(typed: string | undefined): number | undefined {
  const text = (typed ?? '').trim()
  return /^\d+$/.test(text) ? Number(text) : undefined
}

/**
 * Saves the memory budget and the most one service may get, and records settings.update. Both must be whole
 * numbers as typed; what the database then refuses (zero, a max over the budget, ...) comes back as its message.
 */
export async function doSaveResourceSettings(db: Db, actor: Actor, input: SettingsInput): Promise<ActionState> {
  assertAdmin(actor)
  const memoryBudgetMb = wholeNumber(input.memoryBudgetMb)
  const maxServiceMemoryMb = wholeNumber(input.maxServiceMemoryMb)
  if (memoryBudgetMb === undefined || maxServiceMemoryMb === undefined) {
    return {
      fieldErrors: {
        ...(memoryBudgetMb === undefined ? { memoryBudgetMb: NOT_A_WHOLE_NUMBER } : {}),
        ...(maxServiceMemoryMb === undefined ? { maxServiceMemoryMb: NOT_A_WHOLE_NUMBER } : {}),
      },
    }
  }

  const failed = await refusal(() => setResourceSettings(db, { memoryBudgetMb, maxServiceMemoryMb }, actor.id))
  if (failed) return failed
  await auditBestEffort(db, {
    actorId: actor.id,
    action: 'settings.update',
    targetType: 'settings',
    metadata: { memoryBudgetMb, maxServiceMemoryMb },
  })
  return { notice: SETTINGS_SAVED_NOTICE }
}
