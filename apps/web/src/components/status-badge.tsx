import type { DeploymentStatus } from '@vpsm/core'
import { Badge } from '@/components/ui/badge'

// One colour for each status, so that a row of deployments can be read at a glance: grey is waiting, blue and
// violet are under way, green is running, red and orange went wrong, and the two that ended without running
// (replaced by a newer deployment, or removed after a newer one took over) are yellow and an empty outline.
const LOOK: Record<DeploymentStatus, { label: string; tone: string }> = {
  QUEUED: { label: 'Queued', tone: 'border-transparent bg-muted text-muted-foreground' },
  BUILDING: { label: 'Building', tone: 'border-transparent bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300' },
  DEPLOYING: { label: 'Deploying', tone: 'border-transparent bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300' },
  SUCCESS: { label: 'Success', tone: 'border-transparent bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300' },
  FAILED: { label: 'Failed', tone: 'border-transparent bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300' },
  CRASHED: { label: 'Crashed', tone: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300' },
  REMOVED: { label: 'Removed', tone: 'border-border bg-transparent text-muted-foreground' },
  SKIPPED: { label: 'Skipped', tone: 'border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-300' },
}

/** A deployment's status as a badge; no status at all means the service has never been deployed. */
export function StatusBadge({ status }: { status: DeploymentStatus | null }) {
  if (status === null) return <Badge variant="outline">Not deployed</Badge>
  const { label, tone } = LOOK[status]
  return (
    <Badge variant="outline" className={tone} data-status={status}>
      {label}
    </Badge>
  )
}
