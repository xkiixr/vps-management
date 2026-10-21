import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, expect, test } from 'vitest'
import { migrate } from '../src/index'

const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:54329/postgres'
const admin = postgres(adminUrl, { onnotice: () => {} })
const scratchName = `vpsm_migrate_${randomUUID().replaceAll('-', '')}`
const scratchUrl = new URL(adminUrl)
scratchUrl.pathname = `/${scratchName}`

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
  await admin.end()
})

test('concurrent migrations on a fresh database all succeed and apply the schema once', async () => {
  await admin.unsafe(`CREATE DATABASE ${scratchName}`)

  await Promise.all([1, 2, 3, 4].map(() => migrate(scratchUrl.href)))

  const scratch = postgres(scratchUrl.href, { onnotice: () => {} })
  try {
    const tables = await scratch`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
    expect(tables.map((row) => row.table_name)).toEqual([
      'deployment_logs',
      'deployments',
      'domains',
      'environments',
      'projects',
      'service_instances',
      'services',
    ])
    const applied = await scratch`select count(*)::int as n from drizzle.__drizzle_migrations`
    expect(applied[0]!.n).toBe(1)
  } finally {
    await scratch.end()
  }
})
