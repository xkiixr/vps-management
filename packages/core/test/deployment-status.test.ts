import { expect, test } from 'vitest'
import { canTransition, type DeploymentStatus } from '../src/deployment-status'

test.each<[DeploymentStatus, DeploymentStatus]>([
  ['QUEUED', 'BUILDING'], ['QUEUED', 'DEPLOYING'], ['QUEUED', 'SKIPPED'], ['QUEUED', 'FAILED'],
  ['BUILDING', 'DEPLOYING'], ['BUILDING', 'FAILED'], ['DEPLOYING', 'SUCCESS'], ['DEPLOYING', 'FAILED'],
  ['SUCCESS', 'REMOVED'], ['SUCCESS', 'CRASHED'], ['CRASHED', 'REMOVED'],
])('allows %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(true))
test.each<[DeploymentStatus, DeploymentStatus]>([
  ['FAILED', 'SUCCESS'], ['REMOVED', 'SUCCESS'], ['SKIPPED', 'BUILDING'], ['SUCCESS', 'BUILDING'], ['BUILDING', 'SUCCESS'],
])('rejects %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(false))
