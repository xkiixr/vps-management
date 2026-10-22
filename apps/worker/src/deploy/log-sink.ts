import { appendDeploymentLogs, type Db } from '@vpsm/db'

export type LogPhase = 'build' | 'deploy'

export type LogSink = {
  line(phase: LogPhase, text: string): void
  /** Writes everything still buffered. Never rejects. */
  close(): Promise<void>
}

const FLUSH_LINES = 100
const FLUSH_INTERVAL_MS = 250

type Entry = { phase: LogPhase; text: string }

/** Consecutive entries of the same phase, as one batch each (appendDeploymentLogs takes a single phase). */
function runsByPhase(entries: Entry[]): { phase: LogPhase; lines: string[] }[] {
  const runs: { phase: LogPhase; lines: string[] }[] = []
  for (const { phase, text } of entries) {
    const last = runs.at(-1)
    if (last?.phase === phase) last.lines.push(text)
    else runs.push({ phase, lines: [text] })
  }
  return runs
}

/**
 * Buffers a deployment's log lines and writes them in batches: once 100 lines are waiting, or 250 ms
 * after the first one. A failed write is reported on stderr and the deployment carries on.
 */
export function createLogSink(db: Db, deploymentId: string): LogSink {
  let buffer: Entry[] = []
  let timer: NodeJS.Timeout | undefined
  // Writes are chained, so lines reach the database in the order they were logged.
  let writing: Promise<void> = Promise.resolve()

  const write = async (entries: Entry[]) => {
    for (const { phase, lines } of runsByPhase(entries)) {
      try {
        await appendDeploymentLogs(db, deploymentId, phase, lines)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`deployment ${deploymentId}: could not write ${lines.length} log line(s): ${message}`)
      }
    }
  }

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (buffer.length === 0) return
    const entries = buffer
    buffer = []
    writing = writing.then(() => write(entries))
  }

  return {
    line(phase, text) {
      // Postgres text cannot hold NUL; one such byte in build output would otherwise lose the whole batch.
      buffer.push({ phase, text: text.replaceAll('\u0000', '�') })
      if (buffer.length >= FLUSH_LINES) flush()
      else timer ??= setTimeout(flush, FLUSH_INTERVAL_MS)
    },
    async close() {
      flush()
      await writing
    },
  }
}
