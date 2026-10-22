import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAppService, createProject, deploymentLogs, deployments, enqueueDeployment } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { createLogSink } from '../src/deploy/log-sink'

const t = await setupTestDb()
const { db } = t
let deploymentId: string

afterAll(() => t.close())
beforeEach(async () => {
  await t.reset()
  await createProject(db, 'shop')
  const { instance } = await createAppService(db, {
    projectName: 'shop',
    serviceName: 'web',
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  deploymentId = (await enqueueDeployment(db, { serviceInstanceId: instance.id, trigger: 'manual' })).id
})

async function stored(): Promise<[string, string][]> {
  const rows = await db
    .select({ phase: deploymentLogs.phase, line: deploymentLogs.line })
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, deploymentId))
    .orderBy(asc(deploymentLogs.id))
  return rows.map((r) => [r.phase, r.line])
}

test('close() writes every line in order, across phases and batches', async () => {
  const sink = createLogSink(db, deploymentId)
  const expected: [string, string][] = []
  for (let i = 0; i < 250; i++) {
    const phase = i < 120 || i % 7 === 0 ? 'build' : 'deploy'
    sink.line(phase, `line ${i}`)
    expected.push([phase, `line ${i}`])
  }
  await sink.close()
  expect(await stored()).toEqual(expected)
})

test('lines are written without close() after a short delay', async () => {
  const sink = createLogSink(db, deploymentId)
  sink.line('build', 'hello')
  await vi.waitFor(async () => expect(await stored()).toEqual([['build', 'hello']]), { timeout: 2000, interval: 50 })
  await sink.close()
  expect(await stored()).toEqual([['build', 'hello']])
})

test('close() with nothing buffered writes nothing', async () => {
  await createLogSink(db, deploymentId).close()
  expect(await stored()).toEqual([])
})

test('a failing write is reported and does not throw', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    // No such deployment: the insert violates the foreign key.
    const sink = createLogSink(db, randomUUID())
    sink.line('build', 'lost')
    await expect(sink.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toMatch(/could not write 1 log line/)
  } finally {
    error.mockRestore()
  }
})

test('a failed write does not stop later lines from being written', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const [{ serviceInstanceId }] = await db
      .select({ serviceInstanceId: deployments.serviceInstanceId })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
    const laterId = randomUUID()
    const sink = createLogSink(db, laterId)
    sink.line('build', 'lost')
    await sink.close() // fails: the deployment does not exist yet
    await db.insert(deployments).values({ id: laterId, serviceInstanceId: serviceInstanceId!, trigger: 'manual' })
    sink.line('deploy', 'after')
    await sink.close()
    deploymentId = laterId
    expect(await stored()).toEqual([['deploy', 'after']])
    expect(error).toHaveBeenCalledTimes(1)
  } finally {
    error.mockRestore()
  }
})

test('NUL characters, which postgres text cannot hold, are replaced instead of losing the batch', async () => {
  const sink = createLogSink(db, deploymentId)
  sink.line('build', 'before')
  sink.line('build', 'binary \u0000 junk')
  await sink.close()
  expect(await stored()).toEqual([
    ['build', 'before'],
    ['build', 'binary � junk'],
  ])
})

// A single line of minified output can be megabytes; every viewer of the deployment would load it.
describe('a line longer than 8 KiB (UTF-8)', () => {
  const MAX = 8192
  const MARK = ' …[truncated]' // 15 bytes, so at most 8177 bytes of the line are kept
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

  /** Logs `text` as the only line of the deployment and returns what was stored. */
  async function storedLine(text: string): Promise<string> {
    await db.delete(deploymentLogs).where(eq(deploymentLogs.deploymentId, deploymentId))
    const sink = createLogSink(db, deploymentId)
    sink.line('build', text)
    await sink.close()
    const rows = await stored()
    expect(rows).toHaveLength(1)
    return rows[0]![1]
  }

  test('is stored as it is up to 8 KiB', async () => {
    const exact = 'x'.repeat(MAX - 3) + '€' // 8189 + 3 bytes
    expect(bytes(exact)).toBe(MAX)
    expect(await storedLine(exact)).toBe(exact)
  })

  test('is cut to 8 KiB in all, marker included, and says so', async () => {
    const kept = await storedLine('x'.repeat(MAX + 1))
    expect(kept).toBe('x'.repeat(MAX - bytes(MARK)) + MARK)
    expect(bytes(kept)).toBe(MAX)
  })

  test('is cut between characters, never inside one', async () => {
    // 2-byte characters: 8177 bytes would end in the middle of one, so one fewer is kept.
    expect(await storedLine('é'.repeat(5000))).toBe('é'.repeat(4088) + MARK)
    // 4-byte characters (a surrogate pair each in JavaScript): no half of a pair is left behind.
    const emoji = await storedLine('😀'.repeat(3000))
    expect(emoji).toBe('😀'.repeat(2044) + MARK)
    expect(Buffer.from(emoji, 'utf8').toString('utf8')).toBe(emoji)
    // Exactly at the limit after a 1-byte character.
    const fits = await storedLine('a' + '😀'.repeat(3000))
    expect(fits).toBe('a' + '😀'.repeat(2044) + MARK)
    expect(bytes(fits)).toBe(MAX)
  })

  test('NUL characters are replaced before the line is measured', async () => {
    const kept = await storedLine('\u0000'.repeat(MAX))
    expect(kept).toBe('�'.repeat(Math.floor((MAX - bytes(MARK)) / 3)) + MARK)
  })

  test('a huge line becomes one stored line of 8 KiB, and the lines after it are kept', async () => {
    const sink = createLogSink(db, deploymentId)
    sink.line('build', 'y'.repeat(5 * 1024 * 1024))
    sink.line('build', 'after')
    await sink.close()
    const rows = await stored()
    expect(rows.map(([, line]) => bytes(line))).toEqual([MAX, 5])
    expect(rows[1]).toEqual(['build', 'after'])
  })
})
