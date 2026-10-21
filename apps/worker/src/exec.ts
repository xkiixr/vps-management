import { spawn } from 'node:child_process'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'

export type LineHandler = (line: string, stream: 'stdout' | 'stderr') => void

export type RunOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  onLine?: LineHandler
  /** Secret values replaced with `***` in every line before it reaches `onLine`. */
  redact?: string[]
}

export type RunResult = { exitCode: number; timedOut: boolean }

export type RunCommand = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

const KILL_GRACE_MS = 5000
const TIMEOUT_EXIT_CODE = 124

/**
 * Runs a command without a shell (arguments are never interpreted), streams its
 * output line by line with secrets redacted, and enforces an optional timeout
 * (SIGTERM, then SIGKILL after 5 seconds, sent to the command's whole process group). Resolves with the exit code; rejects
 * only when the process cannot be started at all.
 */
export const runCommand: RunCommand = (cmd, args, opts = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    // Longest first, so a secret that contains another one is not left half-visible.
    const secrets = (opts.redact ?? []).filter((s) => s !== '').sort((a, b) => b.length - a.length)
    const redact = (line: string) => secrets.reduce((acc, s) => acc.replaceAll(s, '***'), line)
    const emit = (line: string, stream: 'stdout' | 'stderr') => opts.onLine?.(redact(line), stream)

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout can take down the whole tree (build tools fork helpers).
      detached: true,
    })
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        // Group already gone (or never started); fall back to the direct child, which may also be gone.
        child.kill(signal)
      }
    }

    const splitters = (['stdout', 'stderr'] as const).map((stream) => {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const stripCr = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)
      const push = (text: string) => {
        pending += text
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) emit(stripCr(part), stream)
      }
      child[stream].on('data', (chunk: Buffer) => push(decoder.write(chunk)))
      return () => {
        push(decoder.end())
        if (pending !== '') emit(stripCr(pending), stream)
        pending = ''
      }
    })

    let timedOut = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        signalTree('SIGTERM')
        killTimer = setTimeout(() => {
          signalTree('SIGKILL')
          // A survivor may still hold the pipes open; release them so 'close' fires.
          child.stdout.destroy()
          child.stderr.destroy()
        }, KILL_GRACE_MS)
      }, opts.timeoutMs)
    }

    child.once('error', (err) => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      reject(new Error(`failed to start ${cmd}: ${err.message}`))
    })

    child.once('close', (code, signal) => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      for (const flush of splitters) flush()
      if (timedOut) return resolve({ exitCode: TIMEOUT_EXIT_CODE, timedOut: true })
      const exitCode = code ?? 128 + (signal ? (os.constants.signals[signal] ?? 0) : 0)
      resolve({ exitCode, timedOut: false })
    })
  })
