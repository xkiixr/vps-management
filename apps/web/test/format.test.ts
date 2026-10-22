import { describe, expect, test } from 'vitest'
import type { DeploymentTrigger } from '@vpsm/core'
import { firstLine, formatDateTime, shortSha, triggerLabel } from '@/lib/format'

describe('shortSha', () => {
  test('keeps 7 characters', () => {
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456')
  })
  test('leaves a shorter hash as it is', () => {
    expect(shortSha('abc12')).toBe('abc12')
    expect(shortSha('')).toBe('')
  })
})

describe('firstLine', () => {
  test('is the subject of a commit message', () => {
    expect(firstLine('fix: the thing\n\nA longer description.\nMore.')).toBe('fix: the thing')
    expect(firstLine('  padded  \nbody')).toBe('padded')
    expect(firstLine('one line')).toBe('one line')
    expect(firstLine('')).toBe('')
  })
})

describe('triggerLabel', () => {
  test('has words for every trigger', () => {
    const triggers: DeploymentTrigger[] = ['push', 'manual', 'rollback', 'config', 'restart']
    expect(triggers.map(triggerLabel)).toEqual(['Push', 'Manual', 'Rollback', 'Settings change', 'Restart'])
  })
})

describe('formatDateTime', () => {
  test('is UTC whatever the time zone', () => {
    expect(formatDateTime(new Date('2026-10-22T17:09:59Z'))).toBe('2026-10-22 17:09 UTC')
  })
})
