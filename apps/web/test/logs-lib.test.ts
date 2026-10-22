import { describe, expect, test } from 'vitest'
import { DEPLOYMENT_STATUSES } from '@vpsm/core'
import { appendLines, followingStatus, isFinished, type LogLine, MAX_RENDERED_LINES, stoppedReason } from '@/lib/logs'
import { parseAfter } from '@/server/logs'

const line = (id: number, text = `line ${id}`): LogLine => ({ id, phase: 'build', line: text })
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i))

describe('isFinished', () => {
  const closed = new Date('2026-10-22T10:00:00Z')

  test('a deployment that is over is finished once its log is closed, and not before', () => {
    for (const status of ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'] as const) {
      expect(isFinished({ status, logsClosedAt: closed })).toBe(true)
      expect(isFinished({ status, logsClosedAt: null })).toBe(false)
    }
  })

  test('a skipped deployment never ran, so it is finished whatever its log says', () => {
    expect(isFinished({ status: 'SKIPPED', logsClosedAt: null })).toBe(true)
    expect(isFinished({ status: 'SKIPPED', logsClosedAt: closed })).toBe(true)
  })

  test('a deployment that is still going is never finished, closed log or not', () => {
    for (const status of ['QUEUED', 'BUILDING', 'DEPLOYING'] as const) {
      expect(isFinished({ status, logsClosedAt: null })).toBe(false)
      expect(isFinished({ status, logsClosedAt: closed })).toBe(false)
    }
  })

  test('says something for every status', () => {
    expect(DEPLOYMENT_STATUSES.map((status) => isFinished({ status, logsClosedAt: closed }))).toEqual([
      false, // QUEUED
      false, // BUILDING
      false, // DEPLOYING
      true, // SUCCESS
      true, // FAILED
      true, // CRASHED
      true, // REMOVED
      true, // SKIPPED
    ])
  })
})

describe('followingStatus', () => {
  test('says it is following only while it is', () => {
    expect(followingStatus(false, null)).toContain('Following the log')
    expect(followingStatus(true, null)).toBe('Finished. No more lines will come.')
  })

  test('does not say "Following" once it stopped for good, or while it cannot reach the server', () => {
    for (const problem of ['signed-out', 'gone', 'offline'] as const) {
      expect(followingStatus(false, problem)).not.toContain('Following the log')
    }
    expect(followingStatus(false, 'signed-out')).toBe('Stopped following the log.')
    expect(followingStatus(false, 'gone')).toBe('Stopped following the log.')
    expect(followingStatus(false, 'offline')).toContain('Trying again')
  })
})

describe('stoppedReason', () => {
  test('explains the two problems that end the following, and nothing else', () => {
    expect(stoppedReason('signed-out')).toContain('Sign in again')
    expect(stoppedReason('gone')).toContain('no longer available')
    expect(stoppedReason('offline')).toBeNull()
    expect(stoppedReason(null)).toBeNull()
  })
})

describe('appendLines', () => {
  test('adds the new lines after the ones held', () => {
    expect(appendLines(lines(1, 3), lines(4, 5))).toEqual({ lines: lines(1, 5), dropped: 0 })
  })

  test('starts from nothing, and an answer without lines changes nothing', () => {
    expect(appendLines([], lines(1, 2))).toEqual({ lines: lines(1, 2), dropped: 0 })
    expect(appendLines(lines(1, 2), [])).toEqual({ lines: lines(1, 2), dropped: 0 })
  })

  test('keeps only the last `cap` lines and counts the ones cut off the front', () => {
    expect(appendLines(lines(1, 5), lines(6, 9), 6)).toEqual({ lines: lines(4, 9), dropped: 3 })
    expect(appendLines(lines(1, 2), lines(3, 20), 5)).toEqual({ lines: lines(16, 20), dropped: 15 })
  })

  test('the default cap is the one of the viewer: MAX_RENDERED_LINES', () => {
    const full = lines(1, MAX_RENDERED_LINES)
    expect(appendLines(full, [line(MAX_RENDERED_LINES + 1)])).toMatchObject({ dropped: 1 })
    expect(appendLines(full, [line(MAX_RENDERED_LINES + 1)]).lines).toHaveLength(MAX_RENDERED_LINES)
    expect(appendLines(full, []).dropped).toBe(0)
  })

  test('a line that is not newer than the last one held (an answer that came twice) is ignored', () => {
    expect(appendLines(lines(1, 3), lines(2, 5))).toEqual({ lines: lines(1, 5), dropped: 0 })
    expect(appendLines(lines(1, 3), lines(1, 3))).toEqual({ lines: lines(1, 3), dropped: 0 })
  })

  test('does not change what it was given', () => {
    const current = lines(1, 3)
    const incoming = lines(4, 5)
    appendLines(current, incoming, 2)
    expect(current).toEqual(lines(1, 3))
    expect(incoming).toEqual(lines(4, 5))
  })

  test('line text is kept exactly: whitespace, markup and empty lines', () => {
    const text = ['  indented\t', '<b>bold</b>', '', '\u001b[0m']
    const result = appendLines([], text.map((t, i) => line(i + 1, t)))
    expect(result.lines.map((l) => l.line)).toEqual(text)
  })
})

describe('parseAfter', () => {
  test('no parameter is the start; plain digits are the position', () => {
    expect(parseAfter(null)).toBe(0)
    expect(parseAfter('0')).toBe(0)
    expect(parseAfter('42')).toBe(42)
    expect(parseAfter('007')).toBe(7)
    expect(parseAfter(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  test.each(['', '-1', '1.5', ' 1', '1 ', '+1', '1e3', '0x10', '１２', 'abc', 'NaN', String(Number.MAX_SAFE_INTEGER + 2), '9'.repeat(400)])(
    '%j is not a position',
    (value) => {
      expect(parseAfter(value)).toBeNull()
    },
  )
})
