import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The file the compose healthcheck of the worker tests (`test -f`). It exists only while this run of the worker
 * has migrated the database and finished recovery, so the web dashboard (which waits for a healthy worker)
 * never serves against a schema that is not there yet.
 */
export const READY_FILE = '/tmp/vpsm-worker-ready'

/** Called first thing at startup: a restarted container keeps its /tmp, so the previous run's file must not vouch for this run. */
export async function clearReady(file: string = READY_FILE): Promise<void> {
  await rm(file, { force: true })
}

export async function markReady(file: string = READY_FILE): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'ready\n')
}
