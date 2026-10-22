import { expect, test } from 'vitest'
import { type FieldErrors, validateServiceInput } from '../src/validation'

const limits = { maxServiceMemoryMb: 2048 }

test('valid input has no errors', () => {
  expect(
    validateServiceInput(
      { repo: 'acme/web', branch: 'main', rootDirectory: 'apps/web', healthcheckPath: '/health', port: 3000, memoryLimitMB: 512 },
      limits,
    ),
  ).toEqual({})
})

test('an empty input has no errors', () => {
  expect(validateServiceInput({}, limits)).toEqual({})
})

test.each([
  [{ repo: 'acme web' }, 'repo', 'use the form owner/name'],
  [{ branch: '' }, 'branch', 'branch is required'],
  [{ branch: '-x' }, 'branch', 'invalid branch name'],
  [{ rootDirectory: 'a/../../etc' }, 'rootDirectory', 'must stay inside the repository'],
  [{ healthcheckPath: 'health' }, 'healthcheckPath', 'must start with /'],
  [{ port: 70000 }, 'port', 'must be between 1 and 65535'],
  [{ memoryLimitMB: 0 }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
  [{ memoryLimitMB: 4096 }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
])('%j → %s error', (input, field, message) => {
  expect(validateServiceInput(input, limits)[field as keyof FieldErrors]).toBe(message)
})

test.each(['acme', 'acme/', '/web', 'acme/web/extra', 'acme/we b', 'acme/web\n', ''])('repo %j is rejected', (repo) => {
  expect(validateServiceInput({ repo }, limits).repo).toBe('use the form owner/name')
})

test.each(['acme/web', 'a.b-c_d/e.f-g_h', 'Acme/Web'])('repo %j is accepted', (repo) => {
  expect(validateServiceInput({ repo }, limits).repo).toBeUndefined()
})

test.each(['feature/x', 'v1.2.3', 'main'])('branch %j is accepted', (branch) => {
  expect(validateServiceInput({ branch }, limits).branch).toBeUndefined()
})

test.each(['has space', 'tab\there', 'new\nline', '--upload-pack=x'])('branch %j is rejected as invalid', (branch) => {
  expect(validateServiceInput({ branch }, limits).branch).toBe('invalid branch name')
})

test('a whitespace-only branch is invalid, not missing', () => {
  expect(validateServiceInput({ branch: '   ' }, limits).branch).toBe('invalid branch name')
})

test.each(['apps/web', 'web', '.', 'a/./b', '..foo', 'foo..bar', 'a/b..c/d'])('rootDirectory %j is accepted', (rootDirectory) => {
  expect(validateServiceInput({ rootDirectory }, limits).rootDirectory).toBeUndefined()
})

test.each(['..', '../x', 'a/..', 'a/../b', 'a\\..\\b', '..\\x'])('rootDirectory %j escapes the repository', (rootDirectory) => {
  expect(validateServiceInput({ rootDirectory }, limits).rootDirectory).toBe('must stay inside the repository')
})

test('an empty rootDirectory means the repository root', () => {
  expect(validateServiceInput({ rootDirectory: '' }, limits).rootDirectory).toBeUndefined()
})

test.each(['/', '/health', '/a/b?c=d'])('healthcheckPath %j is accepted', (healthcheckPath) => {
  expect(validateServiceInput({ healthcheckPath }, limits).healthcheckPath).toBeUndefined()
})

test('an empty healthcheckPath does not start with /', () => {
  expect(validateServiceInput({ healthcheckPath: '' }, limits).healthcheckPath).toBe('must start with /')
})

test('a healthcheckPath with whitespace is rejected', () => {
  expect(validateServiceInput({ healthcheckPath: '/he alth' }, limits).healthcheckPath).toBe('must not contain spaces')
  expect(validateServiceInput({ healthcheckPath: '/health\n' }, limits).healthcheckPath).toBe('must not contain spaces')
})

test.each([1, 3000, 65535])('port %j is accepted', (port) => {
  expect(validateServiceInput({ port }, limits).port).toBeUndefined()
})

test.each([0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('port %j is rejected', (port) => {
  expect(validateServiceInput({ port }, limits).port).toBe('must be between 1 and 65535')
})

test.each([6, 512, 2048])('memoryLimitMB %j is accepted', (memoryLimitMB) => {
  expect(validateServiceInput({ memoryLimitMB }, limits).memoryLimitMB).toBeUndefined()
})

test.each([5, 2049, 12.5, Number.NaN])('memoryLimitMB %j is rejected', (memoryLimitMB) => {
  expect(validateServiceInput({ memoryLimitMB }, limits).memoryLimitMB).toBe('must be between 6 and 2048 MB')
})

test('the memory ceiling comes from the limits argument', () => {
  expect(validateServiceInput({ memoryLimitMB: 1024 }, { maxServiceMemoryMb: 512 }).memoryLimitMB).toBe(
    'must be between 6 and 512 MB',
  )
  expect(validateServiceInput({ memoryLimitMB: 512 }, { maxServiceMemoryMb: 512 }).memoryLimitMB).toBeUndefined()
})

test('startCommand is limited to 1000 characters', () => {
  expect(validateServiceInput({ startCommand: 'a'.repeat(1000) }, limits).startCommand).toBeUndefined()
  expect(validateServiceInput({ startCommand: 'a'.repeat(1001) }, limits).startCommand).toBe(
    'must be at most 1000 characters',
  )
})

test('several invalid fields are all reported', () => {
  expect(validateServiceInput({ repo: 'x', branch: '', port: 0 }, limits)).toEqual({
    repo: 'use the form owner/name',
    branch: 'branch is required',
    port: 'must be between 1 and 65535',
  })
})
