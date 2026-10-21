import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { createDb, type Db, type Sql } from './client'
import { migrate } from './migrate'
import * as schema from './schema'

const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:test@localhost:54329/postgres'

const TABLE_NAMES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))

// Migrate once per process (per database URL), however many times setupTestDb() is called.
const migrations = new Map<string, Promise<void>>()

export async function setupTestDb(): Promise<{
  db: Db
  sql: Sql
  reset(): Promise<void>
  close(): Promise<void>
}> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
  if (!migrations.has(url)) migrations.set(url, migrate(url))
  await migrations.get(url)

  const { db, sql, close } = createDb(url)
  const truncateAll = `TRUNCATE ${TABLE_NAMES.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`
  return {
    db,
    sql,
    reset: async () => {
      await sql.unsafe(truncateAll)
    },
    close,
  }
}
