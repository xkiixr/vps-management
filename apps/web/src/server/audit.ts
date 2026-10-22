import { type AuditEntry, type Db, recordAudit } from '@vpsm/db'
import { logServerError } from './errors'

/**
 * Records an audit event. The event is a record of an action, not part of it: failing to write it is logged (never
 * the metadata) and the action stands, so a user is not told an action failed when it was done.
 */
export async function auditBestEffort(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, entry)
  } catch (error) {
    logServerError(`recording ${entry.action}`, error)
  }
}
