import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SourceConfig } from '@vpsm/core'
import { createUser, GITHUB_SYNC_CHANNEL, type GithubRepository, type GithubStatus, type SafeUser } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { RepoDatalist } from '@/components/repo-datalist'
import { NotFoundError } from '@/server/errors'
import { doRequestGithubSync, pushDeployNote, SYNC_REQUESTED_NOTICE } from '@/server/github'
import { PASSWORD } from './helpers'

const source: SourceConfig = { repo: 'acme/web', branch: 'release' }
const status: GithubStatus = { ok: true, checkedAt: '2026-10-23T10:00:00.000Z', appSlug: 'vpsm-deploy' }
const repository: GithubRepository = {
  id: 1,
  fullName: 'acme/web',
  defaultBranch: 'main',
  private: true,
  installationId: 7,
  syncedAt: new Date('2026-10-23T10:00:00Z'),
}

describe('pushDeployNote', () => {
  test.each([
    ['a service without a source', { source: null, status, repository }, null],
    [
      'no GitHub App status',
      { source, status: null, repository: null },
      { tone: 'warning', text: 'The GitHub App is not set up: pushes do not deploy this service.' },
    ],
    [
      'a repository the App cannot read',
      { source, status, repository: null },
      {
        tone: 'warning',
        text: 'The GitHub App cannot read acme/web: pushes do not deploy it, and it builds only if the repository is public.',
      },
    ],
    [
      'a repository the App can read',
      { source, status, repository },
      { tone: 'ok', text: 'Every push to release deploys this service.' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(pushDeployNote(input)).toEqual(expected)
  })

  test('a status that reports an error still counts as set up: the repository list decides', () => {
    const failing: GithubStatus = { ok: false, checkedAt: status.checkedAt, error: 'bad credentials' }
    expect(pushDeployNote({ source, status: failing, repository })).toEqual({
      tone: 'ok',
      text: 'Every push to release deploys this service.',
    })
  })
})

describe('RepoDatalist', () => {
  const html = (repositories: GithubRepository[]) =>
    renderToStaticMarkup(createElement(RepoDatalist, { id: 'github-repositories', repositories }))

  test('suggests every repository with its default branch', () => {
    const other = { ...repository, id: 2, fullName: 'acme/api', defaultBranch: 'trunk' }
    expect(html([repository, other])).toBe(
      '<datalist id="github-repositories">' +
        '<option value="acme/web">default branch main</option>' +
        '<option value="acme/api">default branch trunk</option>' +
        '</datalist>',
    )
  })

  test('renders nothing when there is nothing to suggest', () => {
    expect(html([])).toBe('')
  })

  test('escapes what it is given', () => {
    expect(html([{ ...repository, fullName: 'a"><b>/c' }])).not.toContain('<b>')
  })
})

describe('doRequestGithubSync', () => {
  let t: Awaited<ReturnType<typeof setupTestDb>>
  let root: SafeUser
  let ada: SafeUser
  beforeAll(async () => {
    t = await setupTestDb()
  })
  afterAll(async () => {
    await t?.close()
  })
  beforeEach(async () => {
    await t.reset()
    root = await createUser(t.db, { email: 'root@example.com', name: 'Root', role: 'admin', password: PASSWORD })
    ada = await createUser(t.db, { email: 'ada@example.com', name: 'Ada', role: 'member', password: PASSWORD })
  })

  const audit = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`

  test('requesting a sync notifies the worker and is audited', async () => {
    const heard: string[] = []
    const subscription = await t.sql.listen(GITHUB_SYNC_CHANNEL, (payload) => void heard.push(payload))
    try {
      expect(await doRequestGithubSync(t.db, { id: root.id, role: 'admin' })).toEqual({
        notice: 'Sync requested. The list updates within a minute.',
      })
      await vi.waitFor(() => expect(heard).toEqual(['']))
    } finally {
      await subscription.unlisten()
    }
    expect(SYNC_REQUESTED_NOTICE).toBe('Sync requested. The list updates within a minute.')
    expect(await audit()).toEqual([
      { actor_id: root.id, action: 'github.sync', target_type: 'github', target_id: null, metadata: null },
    ])
  })

  test('a member is turned away with the 404, and nothing is sent or recorded', async () => {
    const heard: string[] = []
    const subscription = await t.sql.listen(GITHUB_SYNC_CHANNEL, (payload) => void heard.push(payload))
    try {
      await expect(doRequestGithubSync(t.db, { id: ada.id, role: 'member' })).rejects.toBeInstanceOf(NotFoundError)
      // A marker sent after the call arrives after anything the call would have notified.
      await t.sql.notify(GITHUB_SYNC_CHANNEL, 'marker')
      await vi.waitFor(() => expect(heard).toContain('marker'))
    } finally {
      await subscription.unlisten()
    }
    expect(heard).toEqual(['marker'])
    expect(await audit()).toEqual([])
  })
})
