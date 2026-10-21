export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'BUILDING',
  'DEPLOYING',
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'REMOVED',
  'SKIPPED',
] as const

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

const ALLOWED_TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  QUEUED: ['BUILDING', 'DEPLOYING', 'SKIPPED', 'FAILED'],
  BUILDING: ['DEPLOYING', 'FAILED'],
  DEPLOYING: ['SUCCESS', 'FAILED'],
  SUCCESS: ['REMOVED', 'CRASHED'],
  CRASHED: ['REMOVED'],
  FAILED: [],
  REMOVED: [],
  SKIPPED: [],
}

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}
