import fs from 'node:fs/promises'
import path from 'node:path'
import type { BuildConfig } from '@vpsm/core'
import { describeDuration } from '../duration'
import { runCommand, type LineHandler, type RunCommand } from '../exec'
import { BuildError } from './errors'

const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 2000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
/** The failure reason is shown to team members, so a long railpack explanation is cut here. */
const MAX_MESSAGE_CHARS = 500
/** railpack's "temporary failure" exit code (for example the network was unreachable). */
const EXIT_TRANSIENT = 75
const EXIT_CANNOT_PLAN = 1

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type InfoLog = { Level?: unknown; Msg?: unknown }

/**
 * Why railpack could not plan the app, from its info file, as one short line: the error-level messages
 * (or every message when none is an error), whitespace collapsed, joined with `; ` and capped.
 * Empty when the file is missing or unreadable.
 */
async function planningFailureReason(infoPath: string): Promise<string> {
  let logs: InfoLog[]
  try {
    const info = JSON.parse(await fs.readFile(infoPath, 'utf8'))
    if (!Array.isArray(info?.logs)) return ''
    logs = info.logs
  } catch {
    return ''
  }
  const entries = logs.filter((log): log is InfoLog & { Msg: string } => typeof log?.Msg === 'string')
  const errors = entries.filter((log) => typeof log.Level === 'string' && log.Level.toLowerCase() === 'error')
  const joined = (errors.length > 0 ? errors : entries)
    .map((log) => log.Msg.replace(/\s+/g, ' ').trim())
    .filter((msg) => msg !== '')
    .join('; ')
  // Counted in characters, so a multi-byte character is never cut in half.
  const chars = Array.from(joined)
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS).join('')}…` : joined
}

/**
 * Runs `railpack prepare` to turn the source into a build plan. Each attempt is limited to `timeoutMs`
 * (default 10 minutes) and a timeout fails at once. Transient failures (exit 75) are retried with a
 * doubling delay; exit 1 means railpack cannot build this app and its own explanation is reported.
 */
export async function railpackPrepare(i: {
  contextDir: string
  outDir: string
  build: BuildConfig
  startCommand?: string
  onLine: LineHandler
  timeoutMs?: number
  run?: RunCommand
  sleep?: (ms: number) => Promise<void>
}): Promise<{ planPath: string; infoPath: string }> {
  const run = i.run ?? runCommand
  const sleep = i.sleep ?? realSleep
  const timeoutMs = i.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const planPath = path.join(i.outDir, 'railpack-plan.json')
  const infoPath = path.join(i.outDir, 'railpack-info.json')

  const args = ['prepare', i.contextDir, '--plan-out', planPath, '--info-out', infoPath]
  if (i.build.buildCommand) args.push('--env', `RAILPACK_BUILD_CMD=${i.build.buildCommand}`)
  if (i.startCommand) args.push('--env', `RAILPACK_START_CMD=${i.startCommand}`)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { exitCode, timedOut } = await run('railpack', args, { onLine: i.onLine, timeoutMs })
    if (timedOut) throw new BuildError(`railpack prepare timed out after ${describeDuration(timeoutMs)}`)
    if (exitCode === 0) return { planPath, infoPath }
    if (exitCode === EXIT_CANNOT_PLAN) {
      const reason = await planningFailureReason(infoPath)
      throw new BuildError(reason === '' ? 'railpack could not plan this app' : `railpack could not plan this app: ${reason}`)
    }
    if (exitCode !== EXIT_TRANSIENT) throw new BuildError(`railpack prepare exited with code ${exitCode}`)
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
  }
  throw new BuildError(`railpack prepare failed after ${MAX_ATTEMPTS} attempts`)
}
