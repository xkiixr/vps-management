import { randomBytes } from 'node:crypto'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { createDb, type Db, type Sql } from './client'
import { migrate } from './migrate'
import * as schema from './schema'

const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:test@localhost:54329/postgres'

const TABLE_NAMES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))

// Runs `fn` on a short-lived connection to the admin database (CREATE/DROP DATABASE).
async function withAdmin<T>(adminUrl: string, fn: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

// Every call creates its own uniquely named, freshly migrated database on the server that
// TEST_DATABASE_URL points at, so test files running in parallel never see each other's rows.
// close() drops it. (A process killed before close() leaves its vpsm_test_* database behind.)
export async function setupTestDb(): Promise<{
  db: Db
  sql: Sql
  reset(): Promise<void>
  close(): Promise<void>
}> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
  const name = `vpsm_test_${process.pid}_${randomBytes(6).toString('hex')}`
  const dropDatabase = () =>
    withAdmin(adminUrl, (admin) => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))

  const url = new URL(adminUrl)
  url.pathname = `/${name}`

  await withAdmin(adminUrl, (admin) => admin.unsafe(`CREATE DATABASE ${name}`))
  try {
    await migrate(url.href)
  } catch (error) {
    await dropDatabase()
    throw error
  }

  const { db, sql, close } = createDb(url.href)
  const truncateAll = `TRUNCATE ${TABLE_NAMES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`
  return {
    db,
    sql,
    reset: async () => {
      await sql.unsafe(truncateAll)
    },
    close: async () => {
      try {
        await close()
      } finally {
        await dropDatabase()
      }
    },
  }
}
