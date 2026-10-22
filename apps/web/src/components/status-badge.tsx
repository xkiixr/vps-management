import type { DeploymentStatus } from '@vpsm/core'
import { Badge } from '@/components/ui/badge'

const LOOK: Record<DeploymentStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  QUEUED: { label: 'Queued', variant: 'secondary' },
  BUILDING: { label: 'Building', variant: 'outline' },
  DEPLOYING: { label: 'Deploying', variant: 'outline' },
  SUCCESS: { label: 'Success', variant: 'default' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  CRASHED: { label: 'Crashed', variant: 'destructive' },
  REMOVED: { label: 'Removed', variant: 'secondary' },
  SKIPPED: { label: 'Skipped', variant: 'secondary' },
}

/** A deployment's status as a badge; no status at all means the service has never been deployed. */
export function StatusBadge({ status }: { status: DeploymentStatus | null }) {
  if (status === null) return <Badge variant="outline">Not deployed</Badge>
  const { label, variant } = LOOK[status]
  return <Badge variant={variant}>{label}</Badge>
}
