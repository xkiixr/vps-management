export function checkMemoryBudget(i: {
  runningMb: number[]
  newMb: number
  budgetMb: number
  maxServiceMb: number
}): { ok: true } | { ok: false; reason: string } {
  if (i.newMb > i.maxServiceMb) {
    return { ok: false, reason: `memory limit ${i.newMb} MB exceeds per-service max ${i.maxServiceMb} MB` }
  }
  const usedMb = i.runningMb.reduce((sum, mb) => sum + mb, 0)
  const availableMb = Math.max(0, i.budgetMb - usedMb)
  if (i.newMb > availableMb) {
    return { ok: false, reason: `memory budget exceeded: need ${i.newMb} MB, available ${availableMb} MB` }
  }
  return { ok: true }
}
