import type { Metadata } from 'next'
import { getGithubStatus, getLastWebhookDelivery, listGithubRepositories } from '@vpsm/db'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '@/lib/format'
import { requestGithubSyncAction } from '@/server/actions/admin'
import { webConfig } from '@/server/config'
import { getDb } from '@/server/db'
import { requireAdmin } from '@/server/guards'
import { SyncForm } from './sync-form'

export const metadata: Metadata = { title: 'GitHub' }

// The worker and the webhook store their times as ISO text; a value that is not a date is shown as it is rather
// than failing the page.
function when(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date)
}

// The web never calls GitHub: everything here was written to the database by the worker (the App's status and the
// repositories it can read) or by the webhook endpoint (the last delivery), and is read fresh on every request.
export default async function GithubPage() {
  await requireAdmin()
  const db = getDb()
  const { panelOrigin, githubWebhookSecret } = webConfig()
  const [status, delivery, repositories] = await Promise.all([
    getGithubStatus(db),
    getLastWebhookDelivery(db),
    listGithubRepositories(db),
  ])

  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold">GitHub</h1>
        <p className="text-sm text-muted-foreground">
          The GitHub App lets the worker clone private repositories, and its webhook deploys a service on every push.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>GitHub App</CardTitle>
          <CardDescription>What the worker found the last time it checked the App.</CardDescription>
        </CardHeader>
        <CardContent>
          {status ? (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">App</dt>
              <dd>{status.appSlug ?? '—'}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="grid gap-1">
                <span>{status.ok ? <Badge variant="outline">OK</Badge> : <Badge variant="destructive">Error</Badge>}</span>
                {status.error && <span className="break-words text-destructive">{status.error}</span>}
              </dd>
              <dt className="text-muted-foreground">Checked</dt>
              <dd>{when(status.checkedAt)}</dd>
              <dt className="text-muted-foreground">Installations</dt>
              <dd>
                {status.installations && status.installations.length > 0 ? (
                  <ul className="grid gap-1">
                    {status.installations.map(({ account, repositories: count }) => (
                      <li key={account}>
                        {account} <span className="text-muted-foreground">({count} {count === 1 ? 'repository' : 'repositories'})</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Not set up: the worker has no GITHUB_APP_ID.</p>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Webhook</CardTitle>
          <CardDescription>
            Set this address as the webhook URL of the GitHub App, with the same secret as GITHUB_WEBHOOK_SECRET.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Webhook URL</dt>
            <dd className="break-all font-mono">{`${panelOrigin}/api/github/webhook`}</dd>
            <dt className="text-muted-foreground">Secret</dt>
            <dd>
              {githubWebhookSecret
                ? 'GITHUB_WEBHOOK_SECRET is set.'
                : 'GITHUB_WEBHOOK_SECRET is not set: the webhook answers 503 and no push deploys anything.'}
            </dd>
            <dt className="text-muted-foreground">Last webhook</dt>
            <dd>
              {delivery ? (
                <span className="grid gap-0.5">
                  <span>
                    {delivery.event} · {when(delivery.receivedAt)}
                  </span>
                  <span className="break-all text-muted-foreground">Delivery {delivery.deliveryId ?? '—'}</span>
                  <span className="break-words text-muted-foreground">{delivery.outcome}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">No webhook received yet.</span>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-labelledby="repositories-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="repositories-heading" className="text-lg font-semibold">
              Repositories
            </h2>
            <p className="text-sm text-muted-foreground">
              The repositories the App can read. They are suggested when you create or change a service.
            </p>
          </div>
          <SyncForm action={requestGithubSyncAction} />
        </div>
        <Card>
          <CardContent>
            {repositories.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">The GitHub App cannot read any repository yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Default branch</TableHead>
                    <TableHead>Visibility</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repositories.map((repository) => (
                    <TableRow key={repository.id}>
                      <TableCell className="font-medium">{repository.fullName}</TableCell>
                      <TableCell className="text-muted-foreground">{repository.defaultBranch}</TableCell>
                      <TableCell>
                        <Badge variant={repository.private ? 'secondary' : 'outline'}>{repository.private ? 'Private' : 'Public'}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
