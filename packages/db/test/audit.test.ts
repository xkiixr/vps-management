import { afterAll, beforeEach, expect, test } from 'vitest'
import { auditEvents, recordAudit, users } from '../src/index'
import { setupTestDb } from '../src/testing'

const t = await setupTestDb()
const { db } = t
beforeEach(() => t.reset())
afterAll(() => t.close())

test('recordAudit stores the event', async () => {
  const [alice] = await db
    .insert(users)
    .values({ email: 'alice@example.com', name: 'alice', role: 'member', passwordHash: 'x' })
    .returning()
  await recordAudit(db, {
    actorId: alice!.id,
    action: 'service.update',
    targetType: 'service',
    targetId: 'shop/web',
    metadata: { fields: ['port', 'branch'] },
  })
  const [event] = await db.select().from(auditEvents)
  expect(event).toMatchObject({
    actorId: alice!.id,
    action: 'service.update',
    targetType: 'service',
    targetId: 'shop/web',
    metadata: { fields: ['port', 'branch'] },
  })
  expect(event!.createdAt).toBeInstanceOf(Date)
})

test('recordAudit accepts an event without an actor, target id or metadata', async () => {
  await recordAudit(db, { actorId: null, action: 'user.create', targetType: 'user' })
  const [event] = await db.select().from(auditEvents)
  expect(event).toMatchObject({ actorId: null, action: 'user.create', targetType: 'user', targetId: null, metadata: null })
})
