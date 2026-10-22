import { describe, expect, test } from 'vitest'
import { bootWorker } from '../src/boot'

// The web dashboard waits for the worker's ready file (compose: web depends on a healthy worker), so the file
// must never exist while the schema is missing or recovery has not finished.

type Name = 'clearReady' | 'migrate' | 'prepare' | 'recover' | 'markReady'

function steps(order: Name[], failing?: Name) {
  const step =
    <T>(name: Name, value: T) =>
    async (): Promise<T> => {
      order.push(name)
      if (name === failing) throw new Error(`${name} failed`)
      return value
    }
  return {
    clearReady: step('clearReady', undefined),
    migrate: step('migrate', undefined),
    prepare: step('prepare', { deps: 'deps' }),
    recover: async (prepared: { deps: string }) => {
      order.push('recover')
      expect(prepared).toEqual({ deps: 'deps' })
      if (failing === 'recover') throw new Error('recover failed')
      return { failed: 0 }
    },
    markReady: step('markReady', undefined),
  }
}

describe('bootWorker', () => {
  test('clears the ready file before it migrates, and marks ready last', async () => {
    const order: Name[] = []
    const result = await bootWorker(steps(order))
    expect(order).toEqual(['clearReady', 'migrate', 'prepare', 'recover', 'markReady'])
    expect(result).toEqual({ prepared: { deps: 'deps' }, recovered: { failed: 0 } })
  })

  test.each<Name>(['clearReady', 'migrate', 'prepare', 'recover', 'markReady'])(
    'when %s fails the error comes out and nothing runs after it',
    async (failing) => {
      const order: Name[] = []
      await expect(bootWorker(steps(order, failing))).rejects.toThrow(`${failing} failed`)
      const all: Name[] = ['clearReady', 'migrate', 'prepare', 'recover', 'markReady']
      expect(order).toEqual(all.slice(0, all.indexOf(failing) + 1))
    },
  )

  test('a failing migration or recovery never marks the worker ready', async () => {
    for (const failing of ['migrate', 'recover'] as const) {
      const order: Name[] = []
      await expect(bootWorker(steps(order, failing))).rejects.toThrow()
      expect(order).not.toContain('markReady')
    }
  })

  test('a step that is still running holds the next one back', async () => {
    const order: string[] = []
    let finishMigration!: () => void
    const migration = new Promise<void>((resolve) => (finishMigration = resolve))
    const booting = bootWorker({
      clearReady: async () => void order.push('clearReady'),
      migrate: async () => {
        order.push('migrate started')
        await migration
        order.push('migrate finished')
      },
      prepare: async () => void order.push('prepare'),
      recover: async () => void order.push('recover'),
      markReady: async () => void order.push('markReady'),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['clearReady', 'migrate started'])
    finishMigration()
    await booting
    expect(order).toEqual(['clearReady', 'migrate started', 'migrate finished', 'prepare', 'recover', 'markReady'])
  })
})
