import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildImage, ensureBuilder } from '../src/build/build-image'
import { chooseBuilder } from '../src/build/choose-builder'
import { railpackPrepare } from '../src/build/railpack'
import { runCommand } from '../src/exec'

// Needs Docker (with buildx) and `railpack` 0.43.0 on PATH; run with INTEGRATION=1.
const RAILPACK_VERSION = '0.43.0'
const TAG = 'vpsm/int-test:1'
const helloNode = fileURLToPath(new URL('../../../examples/hello-node', import.meta.url))

let outDir: string

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-build-int-'))
})

afterAll(async () => {
  await runCommand('docker', ['image', 'rm', '-f', TAG])
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('builds examples/hello-node with railpack', async () => {
  const lines: string[] = []
  const onLine = (line: string) => lines.push(line)

  const version: string[] = []
  await runCommand('railpack', ['--version'], { onLine: (l) => version.push(l) })
  expect(version.join('\n')).toContain(RAILPACK_VERSION)

  const build = { builder: 'auto' as const }
  const builder = await chooseBuilder(helloNode, build)
  expect(builder).toBe('railpack')

  await ensureBuilder(runCommand, onLine)
  const { planPath } = await railpackPrepare({ contextDir: helloNode, outDir, build, onLine })
  await buildImage({
    builder,
    contextDir: helloNode,
    planPath,
    tag: TAG,
    cacheKey: 'int-test',
    frontendImage: `ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}`,
    timeoutMs: 20 * 60_000,
    onLine,
  })

  const inspect = await runCommand('docker', ['image', 'inspect', TAG])
  expect(inspect.exitCode, lines.slice(-30).join('\n')).toBe(0)
}, 600_000)
