import fs from 'node:fs/promises'
import path from 'node:path'
import type { BuildConfig } from '@vpsm/core'
import { runCommand, type LineHandler, type RunCommand } from '../exec'
import { BuildError } from './errors'

const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 2000
/** railpack's "temporary failure" exit code (for example the network was unreachable). */
const EXIT_TRANSIENT = 75
const EXIT_CANNOT_PLAN = 1

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The messages railpack recorded in its info file, or none when the file is missing or unreadable. */
async function planningMessages(infoPath: string): Promise<string[]> {
  try {
    const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as { logs?: { Msg?: unknown }[] }
    if (!Array.isArray(info?.logs)) return []
    return info.logs.flatMap((log) => (typeof log?.Msg === 'string' && log.Msg !== '' ? [log.Msg] : []))
  } catch {
    return []
  }
}

/**
 * Runs `railpack prepare` to turn the source into a build plan. Transient failures (exit 75) are retried
 * with a doubling delay; exit 1 means railpack cannot build this app and its own explanation is reported.
 */
export async function railpackPrepare(i: {
  contextDir: string
  outDir: string
  build: BuildConfig
  startCommand?: string
  onLine: LineHandler
  run?: RunCommand
  sleep?: (ms: number) => Promise<void>
}): Promise<{ planPath: string; infoPath: string }> {
  const run = i.run ?? runCommand
  const sleep = i.sleep ?? realSleep
  const planPath = path.join(i.outDir, 'railpack-plan.json')
  const infoPath = path.join(i.outDir, 'railpack-info.json')

  const args = ['prepare', i.contextDir, '--plan-out', planPath, '--info-out', infoPath]
  if (i.build.buildCommand) args.push('--env', `RAILPACK_BUILD_CMD=${i.build.buildCommand}`)
  if (i.startCommand) args.push('--env', `RAILPACK_START_CMD=${i.startCommand}`)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { exitCode } = await run('railpack', args, { onLine: i.onLine })
    if (exitCode === 0) return { planPath, infoPath }
    if (exitCode === EXIT_CANNOT_PLAN) {
      const messages = await planningMessages(infoPath)
      throw new BuildError(
        messages.length > 0 ? `railpack could not plan this app: ${messages.join('; ')}` : 'railpack could not plan this app',
      )
    }
    if (exitCode !== EXIT_TRANSIENT) throw new BuildError(`railpack prepare exited with code ${exitCode}`)
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
  }
  throw new BuildError(`railpack prepare failed after ${MAX_ATTEMPTS} attempts`)
}
