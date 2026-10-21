import { expect, test } from 'vitest'
import { checkMemoryBudget } from '../src/memory-budget'

test('fits inside budget', () => {
  expect(checkMemoryBudget({ runningMb: [512, 512], newMb: 512, budgetMb: 5632, maxServiceMb: 2048 })).toEqual({ ok: true })
})
test('rejects when over per-service max', () => {
  expect(checkMemoryBudget({ runningMb: [], newMb: 4096, budgetMb: 5632, maxServiceMb: 2048 }))
    .toEqual({ ok: false, reason: 'memory limit 4096 MB exceeds per-service max 2048 MB' })
})
test('rejects when over total budget, counting overlap with old container', () => {
  expect(checkMemoryBudget({ runningMb: [2048, 2048, 1024], newMb: 1024, budgetMb: 5632, maxServiceMb: 2048 }))
    .toEqual({ ok: false, reason: 'memory budget exceeded: need 1024 MB, available 512 MB' })
})
