import postgres from 'postgres'
import { afterAll, expect, test } from 'vitest'
import { projects } from '../src/index'
import { setupTestDb } from '../src/testing'

const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:54329/postgres'
const admin = postgres(adminUrl, { onnotice: () => {} })

afterAll(() => admin.end())

async function currentDatabase(t: Awaited<ReturnType<typeof setupTestDb>>): Promise<string> {
  const rows = await t.sql`select current_database() as name`
  return rows[0]!.name as string
}

async function databaseExists(name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${name}`
  return rows.length === 1
}

test('each setupTestDb() caller gets its own database, so reset() in one never touches another', async () => {
  const [a, b] = await Promise.all([setupTestDb(), setupTestDb()])
  try {
    expect(await currentDatabase(a)).not.toBe(await currentDatabase(b))

    await a.db.insert(projects).values({ name: 'shop' })
    await b.db.insert(projects).values({ name: 'shop' })
    await b.reset()

    expect(await a.db.select().from(projects)).toHaveLength(1)
    expect(await b.db.select().from(projects)).toHaveLength(0)
  } finally {
    await Promise.all([a.close(), b.close()])
  }
})

test('close() drops the database it created', async () => {
  const t = await setupTestDb()
  const name = await currentDatabase(t)
  expect(await databaseExists(name)).toBe(true)

  await t.close()

  expect(await databaseExists(name)).toBe(false)
})
