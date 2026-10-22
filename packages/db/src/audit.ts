import type { Db } from './client'
import { auditEvents } from './schema'

export type AuditEntry = {
  // null for actions taken outside the web dashboard (the worker CLI).
  actorId: string | null
  action: string
  targetType: string
  targetId?: string
  // Stored as given and kept indefinitely. Callers must never put passwords, tokens or other secrets in it:
  // record which fields changed, not their values.
  metadata?: Record<string, unknown>
}

export async function recordAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata,
  })
}
