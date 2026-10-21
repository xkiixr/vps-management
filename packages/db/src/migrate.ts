import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

// Arbitrary constant ('vpsm' as ASCII) so concurrent migrators serialise on one advisory lock.
const MIGRATION_LOCK_KEY = 0x7670736d

export async function migrate(
  url: string,
  migrationsFolder: string = process.env.MIGRATIONS_DIR || DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  // A single connection: the session-level advisory lock and the migration share it,
  // and ending the client releases the lock even if the migration throws.
  const client = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`
    await runMigrations(drizzle(client), { migrationsFolder })
  } finally {
    await client.end()
  }
}
