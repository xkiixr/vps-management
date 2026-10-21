import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Sql = postgres.Sql
export type Db = PostgresJsDatabase<typeof schema>

export function createDb(url: string): { db: Db; sql: Sql; close(): Promise<void> } {
  // Postgres NOTICEs (e.g. "schema already exists, skipping") are not actionable; keep stdout clean.
  const sql = postgres(url, { onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end() }
}
