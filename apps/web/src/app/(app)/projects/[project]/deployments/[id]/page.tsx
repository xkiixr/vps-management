import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { findDeploymentFor, readLogs } from '@vpsm/db'
import { StatusBadge } from '@/components/status-badge'
import { Card, CardContent } from '@/components/ui/card'
import { firstLine, formatDateTime, shortSha, triggerLabel } from '@/lib/format'
import { isFinished, LOG_PAGE_SIZE } from '@/lib/logs'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { LogViewer } from './log-viewer'

type Props = { params: Promise<{ project: string; id: string }> }

// Only what the address already says, so it is the same whether or not the deployment exists or is visible.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { project } = await params
  return { title: `Deployment · ${project}` }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

const dash = <span className="text-muted-foreground">—</span>

export default async function DeploymentPage({ params }: Props) {
  const { project: projectName, id } = await params
  const user = await requireUser()
  const db = getDb()
  // The deployment is looked up through the projects the user may see, and must belong to the project in the
  // address. A deployment that does not exist, one in somebody else's project and one of another project are the
  // same 404.
  const found = await findDeploymentFor(db, { id: user.id, role: user.role }, id)
  if (!found || found.project.name !== projectName) notFound()
  const { deployment, project, service } = found

  // Whether the log is closed was read with the deployment, before the lines: the worker closes it after its last
  // line is written, so a log that was closed then has all its lines now (see doReadLogs).
  const lines = await readLogs(db, deployment.id, 0, LOG_PAGE_SIZE)
  const finished = isFinished(deployment) && lines.length < LOG_PAGE_SIZE

  return (
    <div className="grid gap-6">
      <div>
        <Link href={`/projects/${project.name}/services/${service.name}`} className="text-sm text-muted-foreground hover:underline">
          ← {service.name}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Deployment</h1>
          <span className="font-mono text-sm text-muted-foreground">{deployment.id.slice(0, 8)}</span>
          <StatusBadge status={deployment.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {project.name} / {service.name}
        </p>
      </div>

      <Card>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Trigger">{triggerLabel(deployment.trigger)}</Fact>
            <Fact label="Triggered by">{deployment.createdByEmail ?? dash}</Fact>
            <Fact label="Created">{formatDateTime(deployment.createdAt)}</Fact>
            <Fact label="Started">{deployment.startedAt ? formatDateTime(deployment.startedAt) : dash}</Fact>
            <Fact label="Finished">{deployment.finishedAt ? formatDateTime(deployment.finishedAt) : dash}</Fact>
            <Fact label="Commit">
              {deployment.commitSha ? (
                <>
                  <span className="font-mono">{shortSha(deployment.commitSha)}</span>
                  {deployment.commitMessage && <span className="text-muted-foreground"> {firstLine(deployment.commitMessage)}</span>}
                </>
              ) : (
                dash
              )}
            </Fact>
          </dl>
          {deployment.failureReason && (
            <div className="mt-4 grid gap-0.5">
              <p className="text-xs text-muted-foreground">Failure reason</p>
              <p className="text-sm wrap-break-word whitespace-pre-wrap text-destructive">{deployment.failureReason}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-2" aria-labelledby="log-heading">
        <h2 id="log-heading" className="text-lg font-semibold">
          Log
        </h2>
        <LogViewer
          deploymentId={deployment.id}
          initialLines={lines}
          initialLastId={lines.at(-1)?.id ?? 0}
          initialFinished={finished}
        />
      </section>
    </div>
  )
}
