import type { Sql } from '../src/index'

const NOTIFY_WAIT_MS = 2000
const LOCK_WAIT_TIMEOUT_MS = 5000
const LOCK_POLL_MS = 10

// Collects NOTIFY payloads delivered on `channel` while `action` runs. Postgres delivers notifications in
// commit order, so once a marker sent after the action arrives, everything the action notified has arrived
// too; that marker (or, if it never comes, NOTIFY_WAIT_MS) ends the wait.
export async function listenDuring(sql: Sql, channel: string, action: () => Promise<unknown>): Promise<string[]> {
  const marker = `end-of-listen-${Math.random()}`
  const payloads: string[] = []
  let markerArrived: () => void = () => {}
  const arrived = new Promise<void>((resolve) => (markerArrived = resolve))
  const subscription = await sql.listen(channel, (payload) => {
    if (payload === marker) markerArrived()
    else payloads.push(payload)
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await action()
    await sql.notify(channel, marker)
    await Promise.race([arrived, new Promise((resolve) => (timer = setTimeout(resolve, NOTIFY_WAIT_MS)))])
  } finally {
    clearTimeout(timer)
    await subscription.unlisten()
  }
  return payloads
}

// Resolves once `count` sessions of this database are blocked waiting for a lock, so a test knows that the
// statement it started concurrently has reached the lock it is meant to wait for.
export async function waitForLockWaiters(sql: Sql, count: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
  for (;;) {
    const [row] = await sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`
    if ((row!.waiting as number) >= count) return
    if (Date.now() > deadline) throw new Error(`expected ${count} session(s) waiting for a lock`)
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}
