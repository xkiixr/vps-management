import { appendDeploymentLogs, type Db } from '@vpsm/db'

export type LogPhase = 'build' | 'deploy'

export type LogSink = {
  line(phase: LogPhase, text: string): void
  /** Writes everything still buffered. Never rejects. */
  close(): Promise<void>
}

const FLUSH_LINES = 100
const FLUSH_INTERVAL_MS = 250

/** The most a stored line takes in UTF-8, marker included: a line of minified output can be megabytes. */
export const MAX_LINE_BYTES = 8 * 1024
export const TRUNCATED_MARKER = ' …[truncated]'
const KEPT_BYTES = MAX_LINE_BYTES - Buffer.byteLength(TRUNCATED_MARKER, 'utf8')

/** UTF-8 size of one code point; a lone surrogate is written as U+FFFD, which takes 3 bytes too. */
const utf8Size = (codePoint: number) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4)

/**
 * The line as it is when it fits in MAX_LINE_BYTES; otherwise its longest beginning of whole characters (code
 * points, so never half a character or half a surrogate pair) that leaves room for the marker, plus the marker.
 */
export function capLine(text: string): string {
  // Each UTF-16 unit takes at most 3 bytes, so a short string fits without being measured.
  if (text.length * 3 <= MAX_LINE_BYTES || Buffer.byteLength(text, 'utf8') <= MAX_LINE_BYTES) return text
  let size = 0
  let end = 0
  for (const char of text) {
    size += utf8Size(char.codePointAt(0)!)
    if (size > KEPT_BYTES) break
    end += char.length
  }
  return text.slice(0, end) + TRUNCATED_MARKER
}

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
      buffer.push({ phase, text: capLine(text.replaceAll('\u0000', '�')) })
      if (buffer.length >= FLUSH_LINES) flush()
      else timer ??= setTimeout(flush, FLUSH_INTERVAL_MS)
    },
    async close() {
      flush()
      await writing
    },
  }
}
