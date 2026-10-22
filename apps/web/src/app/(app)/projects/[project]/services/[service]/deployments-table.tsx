import Link from 'next/link'
import type { Deployment } from '@vpsm/db'
import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { firstLine, formatDateTime, shortSha, triggerLabel } from '@/lib/format'
import { RollbackButton } from './rollback-button'

export type DeploymentRow = Deployment & { createdByEmail: string | null }

/**
 * The deployments of a service, newest first. Rollback is offered on a deployment that has an image and is not the
 * one that is live. Everything that comes from a repository or a user (commit message, failure reason, email) is
 * shown as text.
 */
export function DeploymentsTable({
  projectName,
  serviceName,
  deployments,
  liveId,
}: {
  projectName: string
  serviceName: string
  deployments: DeploymentRow[]
  liveId: string | null
}) {
  if (deployments.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No deployments yet.</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Commit</TableHead>
          <TableHead>By</TableHead>
          <TableHead>When</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deployments.map((deployment) => {
          const isLive = deployment.id === liveId
          return (
            <TableRow key={deployment.id}>
              <TableCell className="align-top">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={deployment.status} />
                  {isLive && <span className="text-xs text-muted-foreground">live</span>}
                </div>
                {deployment.failureReason && (
                  <p className="mt-1 max-w-64 text-xs wrap-break-word whitespace-pre-wrap text-destructive">{deployment.failureReason}</p>
                )}
              </TableCell>
              <TableCell className="align-top">{triggerLabel(deployment.trigger)}</TableCell>
              <TableCell className="align-top">
                {deployment.commitSha ? (
                  <>
                    <span className="font-mono text-xs">{shortSha(deployment.commitSha)}</span>
                    {deployment.commitMessage && (
                      <p className="max-w-64 truncate text-xs text-muted-foreground" title={deployment.commitMessage}>
                        {firstLine(deployment.commitMessage)}
                      </p>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="align-top">
                {deployment.createdByEmail ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="align-top whitespace-nowrap text-muted-foreground">
                <time dateTime={deployment.createdAt.toISOString()}>{formatDateTime(deployment.createdAt)}</time>
              </TableCell>
              <TableCell className="align-top">
                <div className="flex items-start justify-end gap-3">
                  <Link
                    href={`/projects/${projectName}/deployments/${deployment.id}`}
                    className="text-sm hover:underline"
                    aria-label={`Logs of deployment ${deployment.id.slice(0, 8)}`}
                  >
                    Logs
                  </Link>
                  {deployment.imageTag && !isLive && (
                    <RollbackButton
                      projectName={projectName}
                      serviceName={serviceName}
                      deploymentId={deployment.id}
                      label={deployment.id.slice(0, 8)}
                    />
                  )}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
