import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { afterAll, expect, test } from 'vitest'
import { migrate } from '../src/index'
import * as schema from '../src/schema'

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))
const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:54329/postgres'
const admin = postgres(adminUrl, { onnotice: () => {} })
const scratchNames: string[] = []
const scratchDirs: string[] = []

async function createScratchDatabase(): Promise<string> {
  const name = `vpsm_migrate_${randomUUID().replaceAll('-', '')}`
  scratchNames.push(name)
  await admin.unsafe(`CREATE DATABASE ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.href
}

type Journal = { entries: { idx: number; tag: string }[] }

async function readJournal(folder: string): Promise<Journal> {
  return JSON.parse(await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8'))
}

afterAll(async () => {
  for (const name of scratchNames) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('concurrent migrations on a fresh database all succeed and apply the schema once', async () => {
  const url = await createScratchDatabase()

  await Promise.all([1, 2, 3, 4].map(() => migrate(url)))

  const scratch = postgres(url, { onnotice: () => {} })
  try {
    const expectedTables = (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table))
      .sort()
    const tables = await scratch`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
    expect(tables.map((row) => row.table_name)).toEqual(expectedTables)
    const { entries } = await readJournal(migrationsDir)
    const applied = await scratch`select count(*)::int as n from drizzle.__drizzle_migrations`
    expect(applied[0]!.n).toBe(entries.length)
  } finally {
    await scratch.end()
  }
})

test('the auth and access migration applies to a database that already has deployments', async () => {
  // A copy of the migrations folder that stops after the first migration, to build the "before" state.
  const baseline = await mkdtemp(path.join(tmpdir(), 'vpsm-migrations-'))
  scratchDirs.push(baseline)
  const journal = await readJournal(migrationsDir)
  const first = journal.entries[0]!
  await mkdir(path.join(baseline, 'meta'))
  await cp(path.join(migrationsDir, `${first.tag}.sql`), path.join(baseline, `${first.tag}.sql`))
  await writeFile(path.join(baseline, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: [first] }))

  const url = await createScratchDatabase()
  await migrate(url, baseline)

  const scratch = postgres(url, { onnotice: () => {} })
  try {
    await scratch`insert into projects (name) values ('shop')`
    await scratch`insert into environments (project_id, name) select id, 'production' from projects`
    await scratch`insert into services (project_id, name) select id, 'web' from projects`
    await scratch`
      insert into service_instances (service_id, environment_id, build, deploy)
      select s.id, e.id, '{}'::jsonb, '{}'::jsonb from services s, environments e`
    await scratch`insert into deployments (service_instance_id, trigger) select id, 'manual' from service_instances`

    await migrate(url)

    const rows = await scratch`select created_by_id from deployments`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.created_by_id).toBeNull()
    const users = await scratch`select count(*)::int as n from users`
    expect(users[0]!.n).toBe(0)
  } finally {
    await scratch.end()
  }
})
