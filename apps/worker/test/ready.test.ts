import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { clearReady, markReady, READY_FILE } from '../src/ready'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vpsm-ready-'))
  file = path.join(dir, 'ready')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the file the compose healthcheck tests is /tmp/vpsm-worker-ready', () => {
  expect(READY_FILE).toBe('/tmp/vpsm-worker-ready')
})

test('markReady creates the file', async () => {
  expect(existsSync(file)).toBe(false)
  await markReady(file)
  expect(existsSync(file)).toBe(true)
})

test('markReady twice is fine', async () => {
  await markReady(file)
  await markReady(file)
  expect(existsSync(file)).toBe(true)
})

// A container that is restarted (not recreated) keeps its /tmp, so the file of the previous run would say
// "migrated" while this run has not started to.
test('clearReady removes the file a previous run of the same container left behind', async () => {
  writeFileSync(file, 'ready')
  await clearReady(file)
  expect(existsSync(file)).toBe(false)
})

test('clearReady without a file is not an error', async () => {
  await expect(clearReady(file)).resolves.toBeUndefined()
})
