/**
 * The worker's startup, in the one order that keeps the ready file honest (the web dashboard starts only once the
 * worker is healthy, and the worker is healthy only while that file exists):
 *
 * 1. `clearReady`: a restarted container keeps its /tmp, so the file of the previous run must go first;
 * 2. `migrate`: the database schema the dashboard reads;
 * 3. `prepare`: everything else the worker needs to run (settings, database connection, Docker);
 * 4. `recover`: marks interrupted deployments FAILED and rewrites the routes;
 * 5. `markReady`, and only when all of the above succeeded: a step that throws ends the boot with its error.
 */
export async function bootWorker<Prepared, Recovered>(steps: {
  clearReady(): Promise<void>
  migrate(): Promise<void>
  prepare(): Promise<Prepared>
  recover(prepared: Prepared): Promise<Recovered>
  markReady(): Promise<void>
}): Promise<{ prepared: Prepared; recovered: Recovered }> {
  await steps.clearReady()
  await steps.migrate()
  const prepared = await steps.prepare()
  const recovered = await steps.recover(prepared)
  await steps.markReady()
  return { prepared, recovered }
}
