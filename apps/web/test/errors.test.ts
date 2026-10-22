import { notFound, redirect } from 'next/navigation'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ValidationError } from '@vpsm/db'
import { actionError, GENERIC_ERROR } from '@/server/errors'
import { nextErrorDigest, NOT_FOUND_DIGEST, redirectTarget } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('actionError', () => {
  test('shows a ValidationError message as it is', () => {
    expect(actionError(new ValidationError('name is required'), 'creating project')).toEqual({ error: 'name is required' })
  })

  test('turns anything else into a generic message and logs it without statement parameters', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('Failed query: select * from users where email = $1\nparams: secret@example.com')
    expect(actionError(failure, 'login')).toEqual({ error: GENERIC_ERROR })
    expect(GENERIC_ERROR).toBe('something went wrong')

    expect(log).toHaveBeenCalledTimes(1)
    const logged = log.mock.calls[0]!.map(String).join(' ')
    expect(logged).toContain('login')
    expect(logged).toContain('Failed query: select * from users where email = $1')
    expect(logged).not.toContain('secret@example.com')
  })

  test('logs a thrown non-Error value too', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(actionError('boom', 'logout')).toEqual({ error: GENERIC_ERROR })
    expect(log).toHaveBeenCalledTimes(1)
  })

  test('rethrows redirect() and notFound() so Next can act on them', async () => {
    const catchAndMap = (fn: () => never) => () => {
      try {
        fn()
      } catch (error) {
        return actionError(error, 'test')
      }
    }
    expect(redirectTarget(await nextErrorDigest(catchAndMap(() => redirect('/login'))))).toBe('/login')
    expect(await nextErrorDigest(catchAndMap(() => notFound()))).toBe(NOT_FOUND_DIGEST)
  })
})
