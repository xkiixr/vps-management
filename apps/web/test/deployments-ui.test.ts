import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { Deployment } from '@vpsm/db'
import { DEPLOYMENT_STATUSES } from '@vpsm/core'
import type { LogLine } from '@/lib/logs'

// The pages are server components and the log viewer uses the router; only what is drawn on the first render is
// looked at here (effects do not run), which is what the browser gets before any script has run.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({}) }))

import { type DeploymentRow, DeploymentsTable } from '@/app/(app)/projects/[project]/services/[service]/deployments-table'
import { DeployActions } from '@/app/(app)/projects/[project]/services/[service]/deploy-actions'
import { LogViewer } from '@/app/(app)/projects/[project]/deployments/[id]/log-viewer'
import { MAX_RENDERED_LINES } from '@/lib/logs'

const LIVE_ID = '11111111-1111-4111-8111-111111111111'
let counter = 0
function deployment(fields: Partial<DeploymentRow> = {}): DeploymentRow {
  counter += 1
  const id = fields.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  return {
    id,
    serviceInstanceId: '22222222-2222-4222-8222-222222222222',
    status: 'FAILED',
    trigger: 'push',
    commitSha: null,
    commitMessage: null,
    imageTag: null,
    containerName: null,
    rollbackOfId: null,
    configSnapshot: null,
    failureReason: null,
    createdById: null,
    createdAt: new Date('2026-10-22T17:09:00Z'),
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    logsClosedAt: null,
    createdByEmail: null,
    ...fields,
  } satisfies Deployment & { createdByEmail: string | null }
}

const table = (deployments: DeploymentRow[], liveId: string | null = LIVE_ID) =>
  renderToStaticMarkup(createElement(DeploymentsTable, { projectName: 'shop', serviceName: 'web', deployments, liveId }))
const rowsOf = (html: string) => html.split('<tr').slice(2)

describe('DeploymentsTable', () => {
  test('says so when there is nothing yet', () => {
    expect(table([])).toContain('No deployments yet.')
    expect(table([])).not.toContain('<table')
  })

  test('shows the status, trigger, 7 characters of the commit with its first line, who, when and the link to the log', () => {
    const row = deployment({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'SUCCESS',
      trigger: 'manual',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      commitMessage: 'fix: the thing\n\nA long description of it.',
      createdByEmail: 'ada@example.com',
      createdAt: new Date('2026-10-22T17:09:59Z'),
    })
    const html = table([row])
    expect(html).toContain('>Success</span>')
    expect(html).toContain('>Manual<')
    expect(html).toContain('>0123456</span>')
    expect(html).not.toContain('01234567')
    expect(html).toContain('>fix: the thing</p>')
    // The rest of the message is in the tooltip (the title), not in the text of the cell.
    expect(html).not.toMatch(/>[^<]*A long description/)
    expect(html).toContain('title="fix: the thing\n\nA long description of it."')
    expect(html).toContain('ada@example.com')
    expect(html).toContain('2026-10-22 17:09 UTC')
    expect(html).toContain('href="/projects/shop/deployments/33333333-3333-4333-8333-333333333333"')
  })

  test('shows the failure reason of a deployment that has one', () => {
    const html = table([deployment({ failureReason: 'build failed: exit code 2' }), deployment()])
    expect(html).toContain('build failed: exit code 2')
    expect(html.match(/build failed/g)).toHaveLength(1)
  })

  test('everything that comes from a repository or a user is text: markup is escaped', () => {
    const html = table([
      deployment({
        commitSha: 'abcdef0123',
        commitMessage: '<img src=x onerror=alert(1)>',
        failureReason: '<script>alert(2)</script>',
        createdByEmail: '"><svg onload=alert(3)>@example.com',
      }),
    ])
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<svg')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
  })

  test('offers Rollback on a deployment that has an image and is not the live one, and nowhere else', () => {
    const live = deployment({ id: LIVE_ID, status: 'SUCCESS', imageTag: 'img:live' })
    const older = deployment({ status: 'REMOVED', imageTag: 'img:older' })
    const noImage = deployment({ status: 'FAILED', imageTag: null })
    const waiting = deployment({ status: 'QUEUED' })
    const rows = rowsOf(table([waiting, live, noImage, older]))
    const [waitingRow, liveRow, noImageRow, olderRow] = rows
    expect(waitingRow).not.toContain('Rollback')
    expect(liveRow).not.toContain('Rollback')
    expect(noImageRow).not.toContain('Rollback')
    expect(olderRow).toContain('>Rollback</button>')
    expect(liveRow).toContain('>live<')
  })

  test('every row has a link to its logs, whatever its status', () => {
    const html = table(DEPLOYMENT_STATUSES.map((status) => deployment({ status })))
    expect(html.match(/>Logs<\/a>/g)).toHaveLength(DEPLOYMENT_STATUSES.length)
  })

  test('no row of the table carries more than the columns need: the settings snapshot is not drawn', () => {
    const html = table([deployment({ configSnapshot: { deploy: { startCommand: 'SECRET=hunter2 node app.js' } } })])
    expect(html).not.toContain('hunter2')
  })
})

describe('DeployActions', () => {
  const render = (canRestart: boolean) =>
    renderToStaticMarkup(createElement(DeployActions, { projectName: 'shop', serviceName: 'web', canRestart }))

  test('has Deploy and Restart buttons', () => {
    const html = render(true)
    expect(html).toContain('>Deploy</button>')
    expect(html).toContain('>Restart</button>')
  })

  test('Restart is disabled while nothing is running, enabled when something is', () => {
    const buttonOf = (html: string) => /<button[^>]*>Restart<\/button>/.exec(html)![0]
    expect(buttonOf(render(false))).toContain(' disabled=""')
    expect(buttonOf(render(true))).not.toContain(' disabled=""')
  })
})

describe('LogViewer', () => {
  const line = (id: number, text: string, phase: LogLine['phase'] = 'build'): LogLine => ({ id, phase, line: text })
  const view = (initialLines: LogLine[], initialFinished = false) =>
    renderToStaticMarkup(createElement(LogViewer, { deploymentId: 'abc', initialLines, initialLastId: initialLines.at(-1)?.id ?? 0, initialFinished }))

  test('draws log lines as text, never as HTML, and keeps their whitespace', () => {
    const html = view([
      line(1, '<img src=x onerror=alert(1)>'),
      line(2, '    indented   with    spaces'),
      line(3, '</div><script>alert(2)</script>'),
      line(4, ''),
    ])
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('>    indented   with    spaces</div>')
    expect(html).toContain('whitespace-pre-wrap')
  })

  test('labels the phases where they change', () => {
    const html = view([line(1, 'a'), line(2, 'b'), line(3, 'c', 'deploy'), line(4, 'd', 'deploy')])
    expect(html.match(/>Build</g)).toHaveLength(1)
    expect(html.match(/>Deploy</g)).toHaveLength(1)
  })

  test('says it is waiting when there is no line yet, and that the deployment wrote none when it is over', () => {
    expect(view([])).toContain('Waiting for the first line')
    expect(view([], true)).toContain('This deployment wrote no log.')
  })

  test('says whether it is still following the log', () => {
    expect(view([line(1, 'a')])).toContain('Following the log')
    const finished = view([line(1, 'a')], true)
    expect(finished).toContain('Finished. No more lines will come.')
    expect(finished).not.toContain('Following the log')
  })

  test('keeps the last 5 000 lines in the page and says how many older ones are not shown', () => {
    const many = Array.from({ length: MAX_RENDERED_LINES + 3 }, (_, i) => line(i + 1, `line ${i + 1}`))
    const html = view(many)
    expect(html.match(/<div class="min-h-5/g)).toHaveLength(MAX_RENDERED_LINES)
    expect(html).toContain('Showing the last 5,000 lines (3 older lines not shown).')
    expect(html).not.toContain('>line 3<')
    expect(html).toContain(`>line ${MAX_RENDERED_LINES + 3}<`)
  })

  test('has no note when nothing was cut off', () => {
    expect(view([line(1, 'a')])).not.toContain('Showing the last')
  })
})
