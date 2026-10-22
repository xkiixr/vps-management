'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  appendLines,
  LOG_PAGE_SIZE,
  LOG_POLL_INTERVAL_MS,
  type LogLine,
  type LogsResponse,
  MAX_RENDERED_LINES,
} from '@/lib/logs'

// How close to the bottom (in pixels) still counts as "at the bottom", so a pixel of rounding does not stop the
// log from following the new lines.
const BOTTOM_SLACK = 24

type Problem = 'signed-out' | 'gone' | 'offline'
const PROBLEMS: Record<Problem, string> = {
  'signed-out': 'Your session has ended. Sign in again to keep following the log.',
  gone: 'This deployment is no longer available.',
  offline: 'Could not reach the server. Trying again…',
}

function isLogsResponse(value: unknown): value is LogsResponse {
  const body = value as Partial<LogsResponse> | null
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray(body.lines) &&
    typeof body.lastId === 'number' &&
    typeof body.finished === 'boolean'
  )
}

/**
 * The log of a deployment: the lines the page was rendered with, then the new ones, fetched every 3 seconds
 * while the deployment has not finished (at once, while a full page keeps coming). Lines are rendered as
 * text, never as HTML, with their whitespace kept. Only the last 5 000 lines are kept in the page. The view
 * follows the end of the log unless the reader has scrolled up.
 */
export function LogViewer({
  deploymentId,
  initialLines,
  initialLastId,
  initialFinished,
}: {
  deploymentId: string
  initialLines: LogLine[]
  initialLastId: number
  initialFinished: boolean
}) {
  const router = useRouter()
  const [view, setView] = useState(() => appendLines([], initialLines))
  const [finished, setFinished] = useState(initialFinished)
  const [problem, setProblem] = useState<Problem | null>(null)
  // Where the next request starts, and how long to wait before the first one: at once if the page was rendered
  // with a full page of lines, as there may be more waiting. Later renders of the page pass other initial
  // values; they must not restart the polling, so these are only read once.
  const lastId = useRef(initialLastId)
  const firstWait = useRef(initialLines.length >= LOG_PAGE_SIZE ? 0 : LOG_POLL_INTERVAL_MS)
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    if (finished) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      let wait = LOG_POLL_INTERVAL_MS
      try {
        const response = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/logs?after=${lastId.current}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 404) {
          // Asking again will not change the answer.
          setProblem(response.status === 401 ? 'signed-out' : 'gone')
          return
        }
        const body: unknown = response.ok ? await response.json() : null
        if (!isLogsResponse(body)) throw new Error('unexpected answer')
        if (controller.signal.aborted) return
        lastId.current = body.lastId
        setProblem(null)
        if (body.lines.length > 0) {
          setView((current) => {
            const next = appendLines(current.lines, body.lines)
            return { lines: next.lines, dropped: current.dropped + next.dropped }
          })
        }
        if (body.finished) {
          setFinished(true)
          // The status, the times and the failure reason on the page are still the ones it was rendered with.
          router.refresh()
          return
        }
        // A full page may not be all there is: go on at once.
        if (body.lines.length >= LOG_PAGE_SIZE) wait = 0
      } catch {
        if (controller.signal.aborted) return
        setProblem('offline')
      }
      timer = setTimeout(poll, wait)
    }

    timer = setTimeout(poll, firstWait.current)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [deploymentId, finished, router])

  // Follow the end of the log, unless the reader scrolled up to read something.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [view])

  function onScroll() {
    const element = scroller.current
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          {finished ? 'Finished. No more lines will come.' : 'Following the log. New lines show up every 3 seconds.'}
        </span>
        {view.dropped > 0 && (
          <span>
            Showing the last {MAX_RENDERED_LINES.toLocaleString('en-US')} lines ({view.dropped.toLocaleString('en-US')} older{' '}
            {view.dropped === 1 ? 'line' : 'lines'} not shown).
          </span>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {PROBLEMS[problem]}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Deployment log"
        aria-live="off"
        className="max-h-[70vh] min-h-48 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-5"
      >
        {view.lines.length === 0 ? (
          <p className="text-muted-foreground">{finished ? 'This deployment wrote no log.' : 'Waiting for the first line…'}</p>
        ) : (
          view.lines.map((entry, index) => (
            <Fragment key={entry.id}>
              {entry.phase !== view.lines[index - 1]?.phase && (
                <div className="mt-2 mb-1 text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase first:mt-0">
                  {entry.phase === 'build' ? 'Build' : 'Deploy'}
                </div>
              )}
              <div className="min-h-5 wrap-break-word whitespace-pre-wrap">{entry.line}</div>
            </Fragment>
          ))
        )}
      </div>
    </div>
  )
}
